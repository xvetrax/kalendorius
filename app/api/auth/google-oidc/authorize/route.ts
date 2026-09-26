/**
 * GET /api/auth/google-oidc/authorize
 *
 * Entry point for Google OIDC login. No auth required.
 * Generates state, nonce, PKCE; stores auth_operation in DB; redirects to Google.
 *
 * Query params:
 *   ?invite=<raw-token>    — invite flow (new user)
 *   ?recovery=<raw-token>  — account recovery flow
 *
 * Security:
 *   - state stored only as SHA-256 hash (state_hash) in DB; raw value in redirect only.
 *   - nonce stored in DB; verified in callback against id_token claim.
 *   - PKCE verifier stored in DB server-side; challenge sent to provider.
 *   - invite validated (not consumed) here; consumed atomically in callback.
 */

import { randomBytes, createHash } from "node:crypto";
import { db, requireUserContext, SESSION_COOKIE } from "@/lib/db-multi";
import { consumeInvite } from "@/lib/user-service";
import { appOrigin } from "@/lib/http";

export const runtime = "nodejs";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function sha256Base64url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

function nowPlus(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return Response.json({ error: "Google OIDC not configured." }, { status: 503 });
  }

  const url = new URL(request.url);
  const inviteToken = url.searchParams.get("invite") ?? undefined;
  const recoveryToken = url.searchParams.get("recovery") ?? undefined;

  let inviteId: number | null = null;

  // Validate invite token if present (do NOT mark used yet)
  if (inviteToken) {
    try {
      const invite = consumeInvite(inviteToken);
      inviteId = invite.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      const errorParam = msg === "invite_expired" ? "invite-expired" : "invite-invalid";
      const origin = appOrigin(request.url);
      return Response.redirect(`${origin}/?error=${errorParam}`, 302);
    }
  }

  // For recovery flow, validate the recovery token similarly
  if (recoveryToken && !inviteToken) {
    try {
      const invite = consumeInvite(recoveryToken);
      inviteId = invite.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      const errorParam = msg === "invite_expired" ? "recovery-expired" : "recovery-invalid";
      const origin = appOrigin(request.url);
      return Response.redirect(`${origin}/?error=${errorParam}`, 302);
    }
  }

  // If a user is already logged in, record session_id for identity linking
  let sessionId: number | null = null;
  try {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const rawToken = parseCookieValue(cookieHeader, SESSION_COOKIE);
    if (rawToken) {
      // Look up session id from the token hash
      const tokenHash = sha256Hex(rawToken);
      const session = db
        .prepare(
          `SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
        )
        .get(tokenHash) as { id: number } | undefined;
      if (session) sessionId = session.id;
    }
  } catch {
    // Not logged in — that's fine for a new login flow
  }

  // Generate state (32 random bytes, hex), nonce (32 random bytes, hex)
  const rawState = randomBytes(32).toString("hex");
  const stateHash = sha256Hex(rawState);
  const nonce = randomBytes(32).toString("hex");

  // Generate PKCE
  const pkceVerifier = randomBytes(32).toString("base64url");
  const pkceChallenge = sha256Base64url(pkceVerifier);

  // Store auth_operation
  db.prepare(`
    INSERT INTO auth_operations (state_hash, nonce, pkce_verifier, provider, invite_id, session_id, callback_path, expires_at, used)
    VALUES (?, ?, ?, 'google', ?, ?, '/api/auth/google-oidc/callback', ?, 0)
  `).run(stateHash, nonce, pkceVerifier, inviteId, sessionId, nowPlus(10));

  // Build redirect URI
  const origin = appOrigin(request.url);
  const redirectUri = `${origin}/api/auth/google-oidc/callback`;

  // Build Google authorization URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", rawState);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", pkceChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "select_account");

  // Fix 1: Bind state to browser via cookie (CSRF protection)
  const secure = origin.startsWith("https://");
  const redirectResponse = Response.redirect(authUrl.toString(), 302);
  redirectResponse.headers.set(
    "Set-Cookie",
    `oauth_state_google=${rawState}; Path=/api/auth/google-oidc/callback; Max-Age=600; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return redirectResponse;
}

// ---------------------------------------------------------------------------
// Cookie parser
// ---------------------------------------------------------------------------

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}
