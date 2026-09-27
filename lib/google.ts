import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt, isTokenEncryptionConfigured } from "@/lib/secrets";
import { oauthRedirectUri } from "@/lib/http";
import { ProviderError } from "@/lib/provider-error";
import {
  getConnection,
  getDecryptedRefreshToken,
  updateRefreshToken,
  deleteConnection,
  saveConnection,
  type OAuthConnectionRow,
  type OAuthProvider,
} from "@/lib/oauth-service";

// Re-export for callers that need these types
export type { OAuthConnectionRow };

const calendarScope = "https://www.googleapis.com/auth/calendar";
const tasksScope = "https://www.googleapis.com/auth/tasks";
/** Scopes requested for Calendar+Tasks data access (NOT OIDC login) */
export const GOOGLE_OAUTH_SCOPES = `${calendarScope} ${tasksScope}`;

export type GoogleTasksStatus =
  | "disconnected"
  | "connected"
  | "permission_required"
  | "api_unavailable";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = oauthRedirectUri(
    process.env.GOOGLE_REDIRECT_URI,
    "/api/google/callback",
  );
  if (!clientId || !clientSecret)
    throw new Error("Neužpildyti Google OAuth nustatymai");
  return { clientId, clientSecret, redirectUri };
}

// ---------------------------------------------------------------------------
// PKCE + Auth URL
// ---------------------------------------------------------------------------

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * googleAuthUrl — builds the Google OAuth authorization URL for Calendar/Tasks
 * access. Does NOT include openid/profile — those are for OIDC login only.
 */
export function googleAuthUrl(
  state: string,
  codeChallenge: string,
  loginHint?: string,
) {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ---------------------------------------------------------------------------
// Code exchange — stores encrypted token per-user in oauth_connections
// ---------------------------------------------------------------------------

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  userId: number,
): Promise<{ tasksConnected: boolean; connectionId: number }> {
  const { clientId, clientSecret, redirectUri } = config();

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error_description || "Google prieigos patvirtinti nepavyko",
    );
  if (!body.access_token)
    throw new Error("Google prieigos patvirtinti nepavyko");

  // Fetch the account profile to get the stable sub identifier
  const profile = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${body.access_token}` } },
  );
  if (!profile.ok) throw new Error("Google paskyros nustatyti nepavyko");
  const account = await profile.json();
  if (!account.sub) throw new Error("Google paskyros nustatyti nepavyko");

  const providerAccountId = String(account.sub);
  const providerEmail = account.email ? String(account.email) : null;

  // Check existing connection for same user+provider to handle token-less re-consent
  const existing = getConnection(userId, "google");
  const sameAccount =
    existing !== null && existing.provider_account_id === providerAccountId;

  if (!body.refresh_token && !sameAccount) {
    throw new Error(
      "Google negrąžino šiai paskyrai tinkamo refresh token",
    );
  }

  // Use the new token, or fall back to the existing encrypted token for same account
  let encryptedToken: string;
  if (body.refresh_token) {
    encryptedToken = encrypt(body.refresh_token);
  } else if (sameAccount && existing!.encrypted_refresh_token) {
    encryptedToken = existing!.encrypted_refresh_token;
  } else {
    throw new Error("Google negrąžino šiai paskyrai tinkamo refresh token");
  }

  const scopes: string =
    typeof body.scope === "string"
      ? body.scope.trim()
      : sameAccount
        ? existing!.scopes
        : "";

  const connectionId = saveConnection(
    userId,
    "google",
    providerAccountId,
    providerEmail,
    encryptedToken,
    scopes,
  );

  // Invalidate any cached token for this connection
  _evictCachedToken(connectionId);

  const tasksConnected = hasScope(scopes, tasksScope);
  return { tasksConnected, connectionId };
}

// ---------------------------------------------------------------------------
// Per-connection token cache (keyed by connectionId + generation)
// ---------------------------------------------------------------------------

interface CachedEntry {
  token: string;
  expiresAt: number;
  generation: number;
}

const tokenCache = new Map<number, CachedEntry>();
const tokenRefreshes = new Map<
  number,
  { generation: number; promise: Promise<string> }
>();

function _evictCachedToken(connectionId: number) {
  tokenCache.delete(connectionId);
  tokenRefreshes.delete(connectionId);
}

export function _clearCachedTokenForTest() {
  tokenCache.clear();
  tokenRefreshes.clear();
}

// ---------------------------------------------------------------------------
// Access token — per connection
// ---------------------------------------------------------------------------

/**
 * getGoogleAccessToken — returns a valid access token for the given connection.
 * Handles refresh transparently, using CAS generation to prevent races.
 */
export async function getGoogleAccessToken(
  conn: OAuthConnectionRow,
): Promise<string> {
  const { id: connectionId, generation } = conn;

  const cached = tokenCache.get(connectionId);
  if (
    cached &&
    cached.generation === generation &&
    cached.expiresAt > Date.now() + 60_000
  ) {
    return cached.token;
  }

  const pending = tokenRefreshes.get(connectionId);
  if (pending && pending.generation === generation) {
    return pending.promise;
  }

  const promise = _refreshGoogleAccessToken(conn);
  tokenRefreshes.set(connectionId, { generation, promise });
  try {
    return await promise;
  } finally {
    const current = tokenRefreshes.get(connectionId);
    if (current && current.promise === promise) {
      tokenRefreshes.delete(connectionId);
    }
  }
}

async function _refreshGoogleAccessToken(
  conn: OAuthConnectionRow,
): Promise<string> {
  const { id: connectionId, generation } = conn;
  const { clientId, clientSecret } = config();

  const refreshToken = getDecryptedRefreshToken(connectionId);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json();

  if (!response.ok) {
    if (body.error === "invalid_grant") {
      throw new ProviderError("Google", 401);
    }
    throw new ProviderError("Google", response.status);
  }
  if (!body.access_token) throw new Error("Google prieigos atnaujinti nepavyko");

  // If a new refresh token was issued, store it with CAS generation guard.
  // The DB generation becomes generation+1 after a successful CAS update, so
  // store the cache entry with the incremented value — this ensures subsequent
  // calls (which re-read the conn and see generation+1) still get a cache hit.
  let effectiveGeneration = generation;
  if (body.refresh_token) {
    try {
      updateRefreshToken(connectionId, encrypt(body.refresh_token), generation);
      effectiveGeneration = generation + 1;
    } catch {
      // Another process already rotated — evict our cache entry, caller will retry
      _evictCachedToken(connectionId);
      throw new Error("Google prisijungimas pasikeitė");
    }
  }

  const entry: CachedEntry = {
    token: body.access_token as string,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    generation: effectiveGeneration,
  };
  tokenCache.set(connectionId, entry);
  return body.access_token as string;
}

// ---------------------------------------------------------------------------
// Connection status helpers (per-user)
// ---------------------------------------------------------------------------

function hasScope(scopes: string, expected: string) {
  return (scopes || "").split(/\s+/).includes(expected);
}

export function isGoogleConnectedForUser(userId: number): boolean {
  const conn = getConnection(userId, "google");
  return conn !== null && conn.status === "active" && conn.encrypted_refresh_token !== null;
}

export function googleAccountForUser(userId: number): string | null {
  const conn = getConnection(userId, "google");
  return conn?.provider_email ?? null;
}

export function googleAccountIdForUser(userId: number): string | null {
  const conn = getConnection(userId, "google");
  return conn?.provider_account_id ?? null;
}

export function googleTasksStatusForUser(userId: number): GoogleTasksStatus {
  const conn = getConnection(userId, "google");
  if (!conn || conn.status !== "active" || !conn.encrypted_refresh_token) {
    return "disconnected";
  }
  if (!hasScope(conn.scopes, tasksScope)) return "permission_required";
  return "connected";
}

export function isGoogleTasksConnectedForUser(userId: number): boolean {
  const status = googleTasksStatusForUser(userId);
  return status === "connected" || status === "api_unavailable";
}

export function disconnectGoogleForUser(userId: number): void {
  _evictAllForUser(userId, "google");
  deleteConnection(userId, "google");
}

function _evictAllForUser(userId: number, provider: OAuthProvider) {
  // Evict by scanning the cache — connectionId is the key
  // We do a best-effort eviction; the generation guard handles races
  for (const [connectionId] of tokenCache) {
    // We can't look up userId from connectionId here without a DB query,
    // so we rely on the generation CAS guard instead. Just clear all.
    tokenCache.delete(connectionId);
    tokenRefreshes.delete(connectionId);
  }
}

export function isGoogleConfigured() {
  try {
    config();
    return isTokenEncryptionConfigured();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API fetch helpers — take connection context explicitly
// ---------------------------------------------------------------------------

/**
 * googleFetchForUser — makes a Google Calendar API request using the
 * per-user connection. Verifies connection is still active before and after.
 */
export async function googleFetchForUser(
  userId: number,
  conn: OAuthConnectionRow,
  path: string,
  init?: RequestInit,
): Promise<any> {
  return _googleApiFetch(userId, conn, "https://www.googleapis.com/calendar/v3", path, init, false);
}

/**
 * googleTasksFetchForUser — makes a Google Tasks API request.
 */
export async function googleTasksFetchForUser(
  userId: number,
  conn: OAuthConnectionRow,
  path: string,
  init?: RequestInit,
): Promise<any> {
  const status = googleTasksStatusForUser(userId);
  if (status === "permission_required") {
    throw new Error("Prijunk Google iš naujo ir suteik Tasks leidimą.");
  }
  if (status !== "connected" && status !== "api_unavailable") {
    throw new Error("Google Tasks neprijungta.");
  }
  return _googleApiFetch(userId, conn, "https://tasks.googleapis.com/tasks/v1", path, init, true);
}

async function _googleApiFetch(
  userId: number,
  conn: OAuthConnectionRow,
  base: string,
  path: string,
  init: RequestInit | undefined,
  tasks: boolean,
): Promise<any> {
  const connectionId = conn.id;

  // Re-read the connection to get current generation before acquiring token
  const current = getConnection(userId, conn.provider as OAuthProvider);
  if (!current || current.status !== "active" || !current.encrypted_refresh_token) {
    throw new Error("Google prisijungimas pasikeitė");
  }

  const token = await getGoogleAccessToken(current);

  // Re-verify connection still belongs to this user (id must match; generation
  // may have incremented if the token was just rotated — that is expected).
  const after = getConnection(userId, conn.provider as OAuthProvider);
  if (!after || after.id !== connectionId) {
    throw new Error("Google prisijungimas pasikeitė");
  }

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ProviderError("Google", response.status);
  }

  const result =
    response.status === 204 || init?.method === "DELETE"
      ? null
      : await response.json();

  return result;
}

// ---------------------------------------------------------------------------
// Legacy single-user shims (kept for backwards compatibility with routes not
// yet migrated; these read from the DB using userId = 0 as a sentinel and
// should be removed once all routes are migrated to per-user context)
// ---------------------------------------------------------------------------
// NOTE: The legacy shims below are intentionally omitted in H4 — all routes
// must be updated to use the per-user functions above.
