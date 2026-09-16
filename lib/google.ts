import { decrypt, encrypt, isTokenEncryptionConfigured } from "@/lib/secrets";
import { db, deleteSettings, saveSetting, setting } from "@/lib/db";
import { oauthRedirectUri } from "@/lib/http";
import { ProviderError } from "@/lib/provider-error";
import { randomUUID } from "node:crypto";

const tasksScope = "https://www.googleapis.com/auth/tasks";
const scope = `openid email profile https://www.googleapis.com/auth/calendar ${tasksScope}`;

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = oauthRedirectUri(process.env.GOOGLE_REDIRECT_URI, "/api/google/callback");
  if (!clientId || !clientSecret) throw new Error("Neužpildyti Google OAuth nustatymai");
  return { clientId, clientSecret, redirectUri };
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
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code: string) {
  const generation=setting("google_connection_generation");
  const { clientId, clientSecret, redirectUri } = config();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const body = await response.json();
  if (!response.ok || !body.refresh_token) throw new Error(body.error_description || "Google negrąžino refresh token");
  if (!body.access_token) throw new Error("Google prieigos patvirtinti nepavyko");
  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${body.access_token}` } });
  if (!profile.ok) throw new Error("Google paskyros nustatyti nepavyko");
  const account=await profile.json();
  if (!account.sub || generation !== setting("google_connection_generation")) throw new Error("Google prisijungimas pasikeitė");
  const encrypted=encrypt(body.refresh_token);
  db.exec("BEGIN IMMEDIATE");
  try {saveSetting("google_refresh_token",encrypted);saveSetting("google_account",String(account.name || account.email || "Google paskyra"));saveSetting("google_account_id",String(account.sub));saveSetting("google_granted_scopes",typeof body.scope === "string" ? body.scope : "");saveSetting("google_connection_generation",randomUUID());db.exec("COMMIT");}
  catch(error) {db.exec("ROLLBACK");throw error;}
}

let tokenRefresh:{generation:string|undefined;promise:Promise<string>}|null=null;
async function accessToken() {
  const stored = setting("google_refresh_token");
  const generation=setting("google_connection_generation");
  if (!stored) throw new Error("Google Calendar neprijungtas");
  if (tokenRefresh && tokenRefresh.generation===generation) return tokenRefresh.promise;
  const pending={generation,promise:refreshAccessToken(stored,generation)};tokenRefresh=pending;
  try {return await pending.promise;} finally {if(tokenRefresh===pending) tokenRefresh=null;}
}
async function refreshAccessToken(stored:string,generation:string|undefined) {
  const { clientId, clientSecret } = config();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decrypt(stored), grant_type: "refresh_token" }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || "Nepavyko atnaujinti Google prieigos");
  if (setting("google_refresh_token")!==stored || setting("google_connection_generation")!==generation) throw new Error("Google prisijungimas pasikeitė");
  if (!body.access_token) throw new Error("Google prieigos atnaujinti nepavyko");
  if (body.refresh_token) saveSetting("google_refresh_token",encrypt(body.refresh_token));
  return body.access_token as string;
}

export function isGoogleConnected() {
  return Boolean(setting("google_refresh_token"));
}

export function googleAccount() { return setting("google_account") || null; }
export function cachedGoogleAccountId() { return setting("google_account_id") || null; }
export async function googleAccountId() { const id=cachedGoogleAccountId();if(!id || !isGoogleConnected()) throw new Error("Google paskyra neprijungta");return id; }
export function isGoogleTasksConnected() { return isGoogleConnected() && Boolean(cachedGoogleAccountId()) && (setting("google_granted_scopes") || "").split(/\s+/).includes(tasksScope); }
export function disconnectGoogle() { deleteSettings("google_refresh_token", "google_account", "google_account_id", "google_granted_scopes");saveSetting("google_connection_generation",randomUUID()); }

export function isGoogleConfigured() {
  try { config(); return isTokenEncryptionConfigured(); } catch { return false; }
}

export async function googleFetch(path: string, init?: RequestInit) {
  return googleApiFetch("https://www.googleapis.com/calendar/v3",path,init);
}
export async function googleTasksFetch(path: string, init?: RequestInit) {
  if (!isGoogleTasksConnected()) throw new Error("Prijunk Google iš naujo ir suteik Tasks leidimą.");
  return googleApiFetch("https://tasks.googleapis.com/tasks/v1",path,init);
}
async function googleApiFetch(base: string, path: string, init?: RequestInit) {
  const generation=setting("google_connection_generation");
  const token=await accessToken();
  if (!isGoogleConnected() || setting("google_connection_generation")!==generation) throw new Error("Google prisijungimas pasikeitė");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new ProviderError("Google",response.status);
  }
  const result=response.status === 204 ? null : await response.json();
  if (!isGoogleConnected() || setting("google_connection_generation")!==generation) throw new Error("Google prisijungimas pasikeitė");
  return result;
}
