/**
 * GET /api/auth/microsoft-oidc/callback
 *
 * Microsoft OIDC authorization code callback.
 *
 * Security:
 *   - Validates state by SHA-256 hash lookup; marks auth_operation used atomically.
 *   - Exchanges code for tokens using PKCE verifier (stored server-side).
 *   - Verifies id_token with verifyMicrosoftIdToken (iss, aud, exp, nonce, signature).
 *   - NEVER stores id_token or access_token — only verified claims.
 *   - Identity linked by verified issuer+subject only; never by email.
 *   - No automatic account merging.
 *   - Logs security_event for every outcome.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { db, createSession, SESSION_COOKIE } from "@/lib/db-multi";
import { addIdentity } from "@/lib/user-service";
import { verifyMicrosoftIdToken } from "@/lib/oidc";
import { appOrigin } from "@/lib/http";

export const runtime = "nodejs";

const MICROSOFT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function ipHint(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const ip = fwd.split(",")[0]?.trim() ?? "";
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
    return ip.slice(0, 8);
  }
  return "";
}

function logSecurityEvent(
  eventType: string,
  opts?: { userId?: number; ipHint?: string; details?: Record<string, unknown> },
): void {
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      opts?.userId ?? null,
      eventType,
      opts?.ipHint ?? null,
      opts?.details ? JSON.stringify(opts.details) : null,
      nowIso(),
    );
  } catch (err) {
    console.error("[security_event] failed to log:", eventType, err);
  }
}

export async function GET(request: Request): Promise<Response> {
  const origin = appOrigin(request.url);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const ip = ipHint(request);

  // Handle provider-side errors (e.g. user denied)
  if (errorParam || !code || !rawState) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: errorParam ?? "missing_params" },
    });
    return Response.redirect(`${origin}/?error=login-cancelled`, 302);
  }

  // Fix 1: Verify state is bound to this browser's cookie (CSRF protection)
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = parseCookieValue(cookieHeader, "oauth_state_ms");
  if (!cookieState) {
    logSecurityEvent("login_failure", { ipHint: ip, details: { provider: "microsoft", reason: "missing_state_cookie" } });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-invalid`, 302), origin);
  }
  const cs = Buffer.from(cookieState), qs = Buffer.from(rawState);
  if (cs.length !== qs.length || !timingSafeEqual(cs, qs)) {
    logSecurityEvent("login_failure", { ipHint: ip, details: { provider: "microsoft", reason: "state_cookie_mismatch" } });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-invalid`, 302), origin);
  }

  const stateHash = sha256Hex(rawState);

  // Look up auth_operation by state hash
  const op = db.prepare(`
    SELECT id, nonce, pkce_verifier, invite_id, session_id, expires_at, used
    FROM auth_operations
    WHERE state_hash = ? AND provider = 'microsoft'
  `).get(stateHash) as {
    id: number;
    nonce: string;
    pkce_verifier: string;
    invite_id: number | null;
    session_id: number | null;
    expires_at: string;
    used: number;
  } | undefined;

  if (!op) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "state_not_found" },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-invalid`, 302), origin);
  }

  if (op.used !== 0) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "state_replayed" },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-replayed`, 302), origin);
  }

  if (new Date(op.expires_at) <= new Date()) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "auth_op_expired" },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-expired`, 302), origin);
  }

  // Mark auth_operation used atomically
  const markResult = db.prepare(`
    UPDATE auth_operations SET used = 1 WHERE id = ? AND used = 0
  `).run(op.id);

  if (markResult.changes === 0) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "state_race" },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-replayed`, 302), origin);
  }

  // Exchange authorization code for tokens
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return clearStateCookie(Response.redirect(`${origin}/?error=not-configured`, 302), origin);
  }

  const redirectUri = `${origin}/api/auth/microsoft-oidc/callback`;

  let idToken: string;
  let tokenTid: string = "common";
  try {
    const tokenResp = await fetch(MICROSOFT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: op.pkce_verifier,
        scope: "openid email profile",
      }),
    });

    if (!tokenResp.ok) {
      const body = await tokenResp.text();
      throw new Error(`Token exchange failed: ${tokenResp.status} ${body.slice(0, 200)}`);
    }

    const tokenData = (await tokenResp.json()) as { id_token?: string };
    if (!tokenData.id_token) {
      throw new Error("Token response missing id_token");
    }
    idToken = tokenData.id_token;

    // Extract tid from the raw JWT payload for issuer validation
    // (verifyMicrosoftIdToken will also extract it, but we need it for the discovery call)
    try {
      const parts = idToken.split(".");
      if (parts.length === 3 && parts[1]) {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payloadStr = Buffer.from(padded, "base64").toString("utf8");
        const payload = JSON.parse(payloadStr) as Record<string, unknown>;
        if (typeof payload.tid === "string") tokenTid = payload.tid;
      }
    } catch {
      // tid extraction failed; fall back to "common"
    }
  } catch (err) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "token_exchange_error", error: String(err).slice(0, 200) },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-failed`, 302), origin);
  }

  // Verify id_token
  let claims: { issuer: string; subject: string; email: string; name: string };
  try {
    claims = await verifyMicrosoftIdToken(idToken, op.nonce, tokenTid, clientId);
  } catch (err) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "id_token_invalid", error: String(err).slice(0, 200) },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=auth-failed`, 302), origin);
  }

  // id_token verified — NEVER store it; work only with claims
  const { issuer, subject, email, name } = claims;

  // --- Invite flow: new user registration ---
  if (op.invite_id !== null) {
    // Re-validate invite
    let invite: { id: number; role: "admin" | "member" };
    try {
      const raw = db.prepare(`
        SELECT id, role, used_at, expires_at FROM invites WHERE id = ?
      `).get(op.invite_id) as { id: number; role: "admin" | "member"; used_at: string | null; expires_at: string } | undefined;
      if (!raw) throw new Error("invite_not_found");
      if (raw.used_at !== null) throw new Error("invite_already_used");
      if (new Date(raw.expires_at) <= new Date()) throw new Error("invite_expired");
      invite = { id: raw.id, role: raw.role };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      logSecurityEvent("login_failure", {
        ipHint: ip,
        details: { provider: "microsoft", reason: `invite_invalid: ${reason}`, subject },
      });
      return clearStateCookie(Response.redirect(`${origin}/?error=invite-invalid`, 302), origin);
    }

    // Fix 3: Atomic invite consumption — claim invite FIRST to prevent race conditions
    let userId: number;
    try {
      db.exec("BEGIN");

      // FIRST: atomically claim the invite (prevents double-use race)
      const inviteClaimResult = db.prepare(`
        UPDATE invites SET used_at = ?, used_by = 0 WHERE id = ? AND used_at IS NULL
      `).run(nowIso(), invite.id);
      if (inviteClaimResult.changes !== 1) {
        db.exec("ROLLBACK");
        logSecurityEvent("login_failure", { ipHint: ip, details: { provider: "microsoft", reason: "invite_race", invite_id: invite.id } });
        return clearStateCookie(Response.redirect(`${origin}/?error=invite-invalid`, 302), origin);
      }

      // THEN create user + identity
      const userResult = db.prepare(`
        INSERT INTO users (display_name, primary_email, role, status, created_at, last_login_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(name || email, email, invite.role, nowIso(), nowIso());
      userId = Number(userResult.lastInsertRowid);

      db.prepare(`
        INSERT INTO auth_identities (user_id, provider, issuer, subject, display_email)
        VALUES (?, 'microsoft', ?, ?, ?)
      `).run(userId, issuer, subject, email || null);

      // Update invite used_by with actual userId (was set to 0 above for atomicity)
      db.prepare(`UPDATE invites SET used_by = ? WHERE id = ?`).run(userId, invite.id);

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      logSecurityEvent("login_failure", {
        ipHint: ip,
        details: { provider: "microsoft", reason: "user_create_error", error: String(err).slice(0, 200) },
      });
      return clearStateCookie(Response.redirect(`${origin}/?error=auth-failed`, 302), origin);
    }

    const { rawToken } = createSession(userId);

    logSecurityEvent("invite_used", {
      userId,
      ipHint: ip,
      details: { provider: "microsoft", invite_id: invite.id },
    });
    logSecurityEvent("login_success", { userId, ipHint: ip, details: { provider: "microsoft" } });

    const resp = Response.redirect(`${origin}/`, 302);
    resp.headers.set("Set-Cookie", sessionCookieHeader(rawToken, origin));
    clearStateCookie(resp, origin);
    return resp;
  }

  // --- Identity linking: adding Microsoft to an existing session ---
  if (op.session_id !== null) {
    // Fix 2: Verify the CURRENT request's session cookie belongs to the same session
    // as the one that initiated the link — prevents CSRF account takeover
    const currentRawToken = parseCookieValue(request.headers.get("cookie") ?? "", SESSION_COOKIE);
    if (!currentRawToken) {
      logSecurityEvent("login_failure", { ipHint: ip, details: { provider: "microsoft", reason: "linking_no_session_cookie" } });
      return clearStateCookie(Response.redirect(`${origin}/?error=session-expired`, 302), origin);
    }
    const currentTokenHash = sha256Hex(currentRawToken);
    const currentSession = db.prepare(`
      SELECT id, user_id FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get(currentTokenHash) as { id: number; user_id: number } | undefined;
    if (!currentSession || currentSession.id !== op.session_id) {
      logSecurityEvent("login_failure", { ipHint: ip, details: { provider: "microsoft", reason: "linking_session_mismatch" } });
      return clearStateCookie(Response.redirect(`${origin}/?error=auth-invalid`, 302), origin);
    }

    try {
      addIdentity(currentSession.user_id, "microsoft", issuer, subject, email || null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      logSecurityEvent("login_failure", {
        ipHint: ip,
        details: {
          provider: "microsoft",
          reason: `identity_link_error: ${reason}`,
          user_id: currentSession.user_id,
        },
      });
      const errorSlug =
        reason === "identity_linked_to_different_user" ? "identity-conflict" : "identity-link-failed";
      return clearStateCookie(Response.redirect(`${origin}/settings?error=${errorSlug}`, 302), origin);
    }

    logSecurityEvent("identity_linked", {
      userId: currentSession.user_id,
      ipHint: ip,
      details: { provider: "microsoft" },
    });

    return clearStateCookie(Response.redirect(`${origin}/settings?linked=microsoft`, 302), origin);
  }

  // --- Returning user login ---
  const identity = db.prepare(`
    SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?
  `).get(issuer, subject) as { user_id: number } | undefined;

  if (!identity) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "no_identity", issuer },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=no-invite`, 302), origin);
  }

  // Verify user is active
  const user = db.prepare(`
    SELECT id, status FROM users WHERE id = ? AND status = 'active'
  `).get(identity.user_id) as { id: number; status: string } | undefined;

  if (!user) {
    logSecurityEvent("login_failure", {
      ipHint: ip,
      details: { provider: "microsoft", reason: "account_disabled", user_id: identity.user_id },
    });
    return clearStateCookie(Response.redirect(`${origin}/?error=account-disabled`, 302), origin);
  }

  // Update last_login_at
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);

  const { rawToken } = createSession(user.id);

  logSecurityEvent("login_success", { userId: user.id, ipHint: ip, details: { provider: "microsoft" } });

  const resp = Response.redirect(`${origin}/`, 302);
  resp.headers.set("Set-Cookie", sessionCookieHeader(rawToken, origin));
  clearStateCookie(resp, origin);
  return resp;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function sessionCookieHeader(rawToken: string, origin: string): string {
  const secure = origin.startsWith("https://");
  return [
    `${SESSION_COOKIE}=${rawToken}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearStateCookie(resp: Response, origin: string): Response {
  const secure = origin.startsWith("https://");
  resp.headers.append(
    "Set-Cookie",
    `oauth_state_ms=; Path=/api/auth/microsoft-oidc/callback; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return resp;
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}
