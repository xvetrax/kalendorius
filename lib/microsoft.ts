import { encrypt, decrypt, isTokenEncryptionConfigured } from "@/lib/secrets";
import { oauthRedirectUri } from "@/lib/http";
import { createHash, randomBytes } from "node:crypto";
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

// Re-export for callers
export type { OAuthConnectionRow };

/** Scopes for Calendar/Tasks data access (NOT OIDC login) */
export const MICROSOFT_OAUTH_SCOPES =
  "offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function config() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = oauthRedirectUri(
    process.env.MICROSOFT_REDIRECT_URI,
    "/api/microsoft/callback",
  );
  const tenant = process.env.MICROSOFT_TENANT || "common";
  if (!clientId || !clientSecret)
    throw new Error("Neužpildyti Microsoft OAuth nustatymai");
  return { clientId, clientSecret, redirectUri, tenant };
}

// ---------------------------------------------------------------------------
// PKCE + Auth URL
// ---------------------------------------------------------------------------

export function generateMicrosoftPKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(40).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * microsoftAuthUrl — builds the Microsoft OAuth authorization URL for
 * Calendar/Tasks access. Does NOT include openid/profile — those are for
 * OIDC login only.
 */
export function microsoftAuthUrl(
  state: string,
  codeChallenge: string,
  loginHint?: string,
) {
  const { clientId, redirectUri, tenant } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MICROSOFT_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`;
}

// ---------------------------------------------------------------------------
// Code exchange — stores encrypted token per-user in oauth_connections
// ---------------------------------------------------------------------------

export async function exchangeMicrosoftCode(
  code: string,
  codeVerifier: string,
  userId: number,
): Promise<{ connectionId: number }> {
  const { clientId, clientSecret, redirectUri, tenant } = config();

  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: MICROSOFT_OAUTH_SCOPES,
        code_verifier: codeVerifier,
      }),
    },
  );
  const body = await response.json();

  if (!response.ok || !body.refresh_token) {
    throw new Error(
      body.error_description || "Microsoft negrąžino refresh token",
    );
  }
  if (!body.access_token)
    throw new Error("Microsoft prieigos patvirtinti nepavyko");

  // Fetch the stable account ID from Graph
  const profile = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    { headers: { authorization: `Bearer ${body.access_token}` } },
  );
  if (!profile.ok) throw new Error("Microsoft paskyros nustatyti nepavyko");
  const account = await profile.json();
  if (!account.id) throw new Error("Microsoft paskyros nustatyti nepavyko");

  const providerAccountId = String(account.id);
  const providerEmail =
    account.mail || account.userPrincipalName
      ? String(account.mail || account.userPrincipalName)
      : null;

  const encryptedToken = encrypt(body.refresh_token);
  const scopes =
    typeof body.scope === "string" ? body.scope.trim() : MICROSOFT_OAUTH_SCOPES;

  const connectionId = saveConnection(
    userId,
    "microsoft",
    providerAccountId,
    providerEmail,
    encryptedToken,
    scopes,
  );

  _evictCachedToken(connectionId);

  return { connectionId };
}

// ---------------------------------------------------------------------------
// Per-connection token cache
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

export async function getMicrosoftAccessToken(
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

  const promise = _refreshMicrosoftAccessToken(conn);
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

async function _refreshMicrosoftAccessToken(
  conn: OAuthConnectionRow,
): Promise<string> {
  const { id: connectionId, generation } = conn;
  const { clientId, clientSecret, tenant } = config();

  const refreshToken = getDecryptedRefreshToken(connectionId);

  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: MICROSOFT_OAUTH_SCOPES,
      }),
    },
  );
  const body = await response.json();

  if (!response.ok) {
    throw new ProviderError(
      "Microsoft",
      response.status,
    );
  }
  if (!body.access_token)
    throw new Error("Microsoft prieigos atnaujinti nepavyko");

  // Track the effective generation: if a new refresh token was issued and stored
  // via CAS, the DB generation is now generation+1.  The cache entry must use
  // that incremented value so the next call (which re-reads the conn and sees
  // generation+1) still gets a cache hit.
  let effectiveGeneration = generation;
  if (body.refresh_token) {
    try {
      updateRefreshToken(connectionId, encrypt(body.refresh_token), generation);
      effectiveGeneration = generation + 1;
    } catch {
      _evictCachedToken(connectionId);
      throw new Error("Microsoft prisijungimas pasikeitė");
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

export function isMicrosoftConnectedForUser(userId: number): boolean {
  const conn = getConnection(userId, "microsoft");
  return (
    conn !== null &&
    conn.status === "active" &&
    conn.encrypted_refresh_token !== null
  );
}

export function microsoftAccountForUser(userId: number): string | null {
  const conn = getConnection(userId, "microsoft");
  return conn?.provider_email ?? null;
}

export function microsoftAccountIdForUser(userId: number): string | null {
  const conn = getConnection(userId, "microsoft");
  return conn?.provider_account_id ?? null;
}

export function disconnectMicrosoftForUser(userId: number): void {
  for (const [connectionId] of tokenCache) {
    tokenCache.delete(connectionId);
    tokenRefreshes.delete(connectionId);
  }
  deleteConnection(userId, "microsoft");
}

export function isMicrosoftConfigured() {
  try {
    config();
    return isTokenEncryptionConfigured();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Graph API fetch helper — takes connection context explicitly
// ---------------------------------------------------------------------------

/**
 * graphFetchForUser — makes a Microsoft Graph API request using the
 * per-user connection. Verifies connection is still active before and after.
 */
export async function graphFetchForUser(
  userId: number,
  conn: OAuthConnectionRow,
  path: string,
  init?: RequestInit,
): Promise<any> {
  const connectionId = conn.id;

  // Re-read to get current generation
  const current = getConnection(userId, conn.provider as OAuthProvider);
  if (
    !current ||
    current.status !== "active" ||
    !current.encrypted_refresh_token
  ) {
    throw new Error("Microsoft prisijungimas pasikeitė");
  }

  const token = await getMicrosoftAccessToken(current);

  // Verify connection still belongs to this user (id must match; generation
  // may have incremented if the token was just rotated — that is expected).
  const after = getConnection(userId, conn.provider as OAuthProvider);
  if (!after || after.id !== connectionId) {
    throw new Error("Microsoft prisijungimas pasikeitė");
  }

  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) throw new ProviderError("Microsoft", response.status);

  const result =
    response.status === 202 || response.status === 204
      ? null
      : await response.json();

  // Final connection check
  const final = getConnection(userId, conn.provider as OAuthProvider);
  if (!final || final.id !== connectionId) {
    throw new Error("Microsoft prisijungimas pasikeitė");
  }

  return result;
}

/**
 * defaultTaskListIdForUser — returns the default Microsoft To Do list ID,
 * caching in user_settings via the caller pattern.
 */
export async function defaultTaskListIdForUser(
  userId: number,
  conn: OAuthConnectionRow,
): Promise<string> {
  const data = await graphFetchForUser(userId, conn, "/me/todo/lists");
  const list =
    data.value?.find(
      (item: { wellknownListName?: string }) =>
        item.wellknownListName === "defaultList",
    ) || data.value?.[0];
  if (!list?.id) throw new Error("Microsoft To Do užduočių sąrašas nerastas");
  return list.id as string;
}
