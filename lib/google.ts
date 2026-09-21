import { randomUUID } from "node:crypto";
import { decrypt, encrypt, isTokenEncryptionConfigured } from "@/lib/secrets";
import { db, deleteSettings, saveSetting, setting } from "@/lib/db";
import { oauthRedirectUri } from "@/lib/http";
import { ProviderError } from "@/lib/provider-error";

const tasksScope = "https://www.googleapis.com/auth/tasks";
const calendarScope = "https://www.googleapis.com/auth/calendar";
const scope = `openid email profile ${calendarScope} ${tasksScope}`;
const tasksStatusSetting = "google_tasks_status";

export type GoogleTasksStatus = "disconnected" | "connected" | "permission_required" | "api_unavailable";

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = oauthRedirectUri(process.env.GOOGLE_REDIRECT_URI, "/api/google/callback");
  if (!clientId || !clientSecret) throw new Error("Neužpildyti Google OAuth nustatymai");
  return { clientId, clientSecret, redirectUri };
}

function grantedScopes(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}

function hasScope(scopes: string | undefined, expected: string) {
  return (scopes || "").split(/\s+/).includes(expected);
}

export function googleAuthUrl(state: string) {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  const accountId = cachedGoogleAccountId();
  if (accountId) params.set("login_hint", accountId);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string) {
  const generation = setting("google_connection_generation");
  const previousToken = setting("google_refresh_token");
  const previousAccountId = setting("google_account_id");
  const { clientId, clientSecret, redirectUri } = config();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || "Google prieigos patvirtinti nepavyko");
  if (!body.access_token) throw new Error("Google prieigos patvirtinti nepavyko");

  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${body.access_token}` } });
  if (!profile.ok) throw new Error("Google paskyros nustatyti nepavyko");
  const account = await profile.json();
  if (!account.sub || generation !== setting("google_connection_generation")) throw new Error("Google prisijungimas pasikeitė");

  const sameAccount = Boolean(previousToken && previousAccountId && previousAccountId === String(account.sub));
  if (!body.refresh_token && !sameAccount) throw new Error("Google negrąžino šiai paskyrai tinkamo refresh token");
  // A concurrent refresh may have rotated the same account's token while the
  // consent screen was open. Reuse the latest stored token, never the snapshot.
  const encryptedToken = body.refresh_token ? encrypt(body.refresh_token) : setting("google_refresh_token")!;
  const responseScopes = grantedScopes(body.scope);
  // A missing scope field is not evidence of a new grant. Preserve only scopes
  // previously observed for the same account; never copy them to another account.
  const scopes = responseScopes ?? (sameAccount && !body.refresh_token ? setting("google_granted_scopes") || "" : "");

  db.exec("BEGIN IMMEDIATE");
  try {
    saveSetting("google_refresh_token", encryptedToken);
    saveSetting("google_account", String(account.name || account.email || "Google paskyra"));
    saveSetting("google_account_id", String(account.sub));
    saveSetting("google_granted_scopes", scopes);
    db.prepare("DELETE FROM settings WHERE key = ?").run(tasksStatusSetting);
    saveSetting("google_connection_generation", randomUUID());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { tasksConnected: hasScope(scopes, tasksScope) };
}

let tokenRefresh: {generation: string | undefined; promise: Promise<string>} | null = null;
let cachedToken: {token: string; expiresAt: number; generation: string} | null = null;

async function accessToken() {
  const stored = setting("google_refresh_token");
  const generation = setting("google_connection_generation");
  if (!stored) throw new Error("Google Calendar neprijungtas");
  if (cachedToken !== null && cachedToken.generation === generation && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  if (tokenRefresh && tokenRefresh.generation === generation) return tokenRefresh.promise;
  const pending = { generation, promise: refreshAccessToken(stored, generation) };
  tokenRefresh = pending;
  try { return await pending.promise; }
  finally { if (tokenRefresh === pending) tokenRefresh = null; }
}

async function refreshAccessToken(stored: string, generation: string | undefined) {
  const { clientId, clientSecret } = config();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decrypt(stored), grant_type: "refresh_token" }),
  });
  const body = await response.json();
  if (setting("google_refresh_token") !== stored || setting("google_connection_generation") !== generation) throw new Error("Google prisijungimas pasikeitė");
  if (!response.ok) {
    if (body.error === "invalid_grant") saveSetting(tasksStatusSetting, "permission_required");
    throw new ProviderError("Google", body.error === "invalid_grant" ? 401 : response.status);
  }
  if (!body.access_token) throw new Error("Google prieigos atnaujinti nepavyko");

  const responseScopes = grantedScopes(body.scope);
  if (body.refresh_token || responseScopes !== undefined) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (setting("google_refresh_token") !== stored || setting("google_connection_generation") !== generation) throw new Error("Google prisijungimas pasikeitė");
      if (body.refresh_token) saveSetting("google_refresh_token", encrypt(body.refresh_token));
      if (responseScopes !== undefined) {
        saveSetting("google_granted_scopes", responseScopes);
        if (hasScope(responseScopes, tasksScope) && setting(tasksStatusSetting) === "permission_required") {
          db.prepare("DELETE FROM settings WHERE key = ?").run(tasksStatusSetting);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  cachedToken = {token: body.access_token as string, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000, generation: generation as string};
  return body.access_token as string;
}

export function _clearCachedTokenForTest() { cachedToken = null; tokenRefresh = null; }
export function isGoogleConnected() {
  return Boolean(setting("google_refresh_token"));
}

export function googleAccount() { return setting("google_account") || null; }
export function cachedGoogleAccountId() { return setting("google_account_id") || null; }
export async function googleAccountId() {
  const id = cachedGoogleAccountId();
  if (!id || !isGoogleConnected()) throw new Error("Google paskyra neprijungta");
  return id;
}

export function googleTasksStatus(): GoogleTasksStatus {
  if (!isGoogleConnected()) return "disconnected";
  if (!cachedGoogleAccountId() || !hasScope(setting("google_granted_scopes"), tasksScope)) return "permission_required";
  const observed = setting(tasksStatusSetting);
  if (observed === "permission_required" || observed === "api_unavailable") return observed;
  return "connected";
}

export function isGoogleTasksConnected() {
  const status = googleTasksStatus();
  // An API configuration failure can be fixed outside this app. Continue to
  // retry on refresh; it must not permanently disable discovery or local plans.
  return status === "connected" || status === "api_unavailable";
}

export function disconnectGoogle() {
  cachedToken = null;
  deleteSettings("google_refresh_token", "google_account", "google_account_id", "google_granted_scopes", tasksStatusSetting);
  saveSetting("google_connection_generation", randomUUID());
}

export function isGoogleConfigured() {
  try { config(); return isTokenEncryptionConfigured(); }
  catch { return false; }
}

export async function googleFetch(path: string, init?: RequestInit) {
  return googleApiFetch("https://www.googleapis.com/calendar/v3", path, init, false);
}

export async function googleTasksFetch(path: string, init?: RequestInit) {
  assertTasksAvailable();
  return googleApiFetch("https://tasks.googleapis.com/tasks/v1", path, init, true);
}

function assertTasksAvailable() {
  const status = googleTasksStatus();
  if (status === "permission_required") throw new Error("Prijunk Google iš naujo ir suteik Tasks leidimą.");
  if (status !== "connected" && status !== "api_unavailable") throw new Error("Google Tasks neprijungta.");
}

function googleErrorReasons(body: unknown) {
  if (!body || typeof body !== "object") return [];
  const error = (body as {error?: unknown}).error;
  if (!error || typeof error !== "object") return [];
  const value = error as {status?: unknown; errors?: unknown; details?: unknown};
  const reasons = typeof value.status === "string" ? [value.status] : [];
  for (const collection of [value.errors, value.details]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (item && typeof item === "object" && typeof (item as {reason?: unknown}).reason === "string") reasons.push((item as {reason: string}).reason);
    }
  }
  return reasons;
}

function rememberTasksFailure(body: unknown, generation: string | undefined) {
  if (!isGoogleConnected() || setting("google_connection_generation") !== generation) return;
  const reasons = googleErrorReasons(body);
  if (reasons.some(reason => ["accessNotConfigured", "SERVICE_DISABLED", "API_DISABLED"].includes(reason))) {
    saveSetting(tasksStatusSetting, "api_unavailable");
  } else if (reasons.some(reason => ["insufficientPermissions", "insufficientAuthenticationScopes", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"].includes(reason))) {
    saveSetting(tasksStatusSetting, "permission_required");
  }
}

async function googleApiFetch(base: string, path: string, init: RequestInit | undefined, tasks: boolean) {
  const generation = setting("google_connection_generation");
  const token = await accessToken();
  if (!isGoogleConnected() || setting("google_connection_generation") !== generation) throw new Error("Google prisijungimas pasikeitė");
  // A refresh response can report that the Tasks scope was revoked. Do not make
  // a doomed Tasks request, and leave Calendar available through the same token.
  if (tasks) assertTasksAvailable();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    if (tasks) {
      const errorBody = await response.clone().json().catch(() => null);
      rememberTasksFailure(errorBody, generation);
    }
    throw new ProviderError("Google", response.status);
  }
  const result = response.status === 204 || init?.method === "DELETE" ? null : await response.json();
  if (!isGoogleConnected() || setting("google_connection_generation") !== generation) throw new Error("Google prisijungimas pasikeitė");
  if (tasks && setting(tasksStatusSetting)) db.prepare("DELETE FROM settings WHERE key = ?").run(tasksStatusSetting);
  return result;
}
