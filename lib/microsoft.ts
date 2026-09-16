import { decrypt, encrypt, isTokenEncryptionConfigured } from "@/lib/secrets";
import { db, deleteSettings, saveSetting, setting } from "@/lib/db";
import { oauthRedirectUri } from "@/lib/http";
import { randomUUID } from "node:crypto";
import { ProviderError } from "@/lib/provider-error";

const scopes = "openid profile offline_access User.Read Calendars.ReadWrite Tasks.ReadWrite";

function config() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = oauthRedirectUri(process.env.MICROSOFT_REDIRECT_URI, "/api/microsoft/callback");
  const tenant = process.env.MICROSOFT_TENANT || "common";
  if (!clientId || !clientSecret) throw new Error("Neužpildyti Microsoft OAuth nustatymai");
  return { clientId, clientSecret, redirectUri, tenant };
}

export function microsoftAuthUrl(state: string) {
  const { clientId, redirectUri, tenant } = config();
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: scopes, state });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeMicrosoftCode(code: string) {
  const generation = setting("microsoft_connection_generation");
  const { clientId, clientSecret, redirectUri, tenant } = config();
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: scopes }),
  });
  const body = await response.json();
  if (!response.ok || !body.refresh_token) throw new Error(body.error_description || "Microsoft negrąžino refresh token");
  if (!body.access_token) throw new Error("Microsoft prieigos patvirtinti nepavyko");
  const profile = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", { headers: { authorization: `Bearer ${body.access_token}` } });
  if (!profile.ok) throw new Error("Microsoft paskyros nustatyti nepavyko");
  const account = await profile.json();
  if (!account.id) throw new Error("Microsoft paskyros nustatyti nepavyko");
  if (setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė");
  // Never attach a new token to an old account identity after a profile failure.
  const encrypted = encrypt(body.refresh_token);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM settings WHERE key = 'microsoft_task_list_id'").run();
    saveSetting("microsoft_refresh_token", encrypted);
    saveSetting("microsoft_account_id", String(account.id));
    saveSetting("microsoft_account", String(account.displayName || account.mail || account.userPrincipalName || "Microsoft paskyra"));
    saveSetting("microsoft_connection_generation", randomUUID());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

let tokenRefresh: {generation: string | undefined; promise: Promise<string>} | null = null;
async function accessToken() {
  const stored = setting("microsoft_refresh_token");
  const generation = setting("microsoft_connection_generation");
  if (!stored) throw new Error("Outlook neprijungtas");
  if (tokenRefresh?.generation === generation && tokenRefresh) return tokenRefresh.promise;
  const pending = {generation,promise:refreshAccessToken(stored,generation)};
  tokenRefresh=pending;
  try {return await pending.promise;} finally {if (tokenRefresh === pending) tokenRefresh=null;}
}

async function refreshAccessToken(stored: string, generation: string | undefined) {
  const { clientId, clientSecret, tenant } = config();
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: decrypt(stored), grant_type: "refresh_token", scope: scopes }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || "Nepavyko atnaujinti Microsoft prieigos");
  if (setting("microsoft_refresh_token") !== stored || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė. Pakartok veiksmą.");
  if (!body.access_token) throw new Error("Microsoft prieigos atnaujinti nepavyko");
  if (body.refresh_token) saveSetting("microsoft_refresh_token", encrypt(body.refresh_token));
  return body.access_token as string;
}

export function isMicrosoftConnected() { return Boolean(setting("microsoft_refresh_token")); }
export function microsoftAccount() { return setting("microsoft_account") || null; }
export function cachedMicrosoftAccountId() { return setting("microsoft_account_id") || null; }
export async function microsoftAccountId() {
  if (!isMicrosoftConnected()) throw new Error("Microsoft neprijungtas");
  const cached = cachedMicrosoftAccountId();
  if (cached) return cached;
  const generation = setting("microsoft_connection_generation");
  const profile = await graphFetch("/me?$select=id");
  if (!profile?.id || !isMicrosoftConnected() || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft paskyros nustatyti nepavyko");
  saveSetting("microsoft_account_id", String(profile.id));
  return String(profile.id);
}
export function disconnectMicrosoft() { deleteSettings("microsoft_refresh_token", "microsoft_task_list_id", "microsoft_account", "microsoft_account_id"); saveSetting("microsoft_connection_generation", randomUUID()); }
export function isMicrosoftConfigured() {
  try { config(); return isTokenEncryptionConfigured(); } catch { return false; }
}

export async function graphFetch(path: string, init?: RequestInit) {
  const generation = setting("microsoft_connection_generation");
  const token = await accessToken();
  if (!isMicrosoftConnected() || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė");
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!isMicrosoftConnected() || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė");
  if (!response.ok) throw new ProviderError("Microsoft",response.status);
  const result = response.status === 204 ? null : await response.json();
  if (!isMicrosoftConnected() || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė");
  return result;
}

export async function defaultTaskListId() {
  const cached = setting("microsoft_task_list_id");
  if (cached) return cached;
  const generation = setting("microsoft_connection_generation");
  const data = await graphFetch("/me/todo/lists");
  if (!isMicrosoftConnected() || setting("microsoft_connection_generation") !== generation) throw new Error("Microsoft prisijungimas pasikeitė");
  const list = data.value?.find((item: { wellknownListName?: string }) => item.wellknownListName === "defaultList") || data.value?.[0];
  if (!list?.id) throw new Error("Microsoft To Do užduočių sąrašas nerastas");
  saveSetting("microsoft_task_list_id", list.id);
  return list.id as string;
}
