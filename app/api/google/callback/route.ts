import { createHash, timingSafeEqual } from "node:crypto";
import { exchangeCode, isGoogleTasksConnectedForUser } from "@/lib/google";
import { oauthResultUrl } from "@/lib/http";
import { db } from "@/lib/db-multi";

/** Build a redirect response that clears the connect-state cookie. */
function redirectWithClear(targetUrl: string, clearStateCookie: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: targetUrl, "Set-Cookie": clearStateCookie },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  const isSecure = url.protocol === "https:";
  const clearStateCookie = `google_connect_state=; Path=/api/google/callback; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`;

  if (!stateParam) {
    return Response.redirect(oauthResultUrl(request.url, "google", "error").href);
  }

  // Fix 1: verify state is bound to this browser's cookie (CSRF protection)
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState =
    cookieHeader.match(/(?:^|;)\s*google_connect_state=([^;]+)/)?.[1] ?? null;
  if (!cookieState) {
    return Response.redirect(oauthResultUrl(request.url, "google", "error").href);
  }
  const cs = Buffer.from(cookieState);
  const qs = Buffer.from(stateParam);
  if (cs.length !== qs.length || !timingSafeEqual(cs, qs)) {
    return Response.redirect(oauthResultUrl(request.url, "google", "error").href);
  }

  // Look up the auth_operation by state hash (never trust the raw state)
  const stateHash = createHash("sha256").update(stateParam).digest("hex");

  const op = db
    .prepare(`
      SELECT id, pkce_verifier, nonce, used, expires_at
      FROM auth_operations
      WHERE state_hash = ? AND provider = 'google'
    `)
    .get(stateHash) as
    | { id: number; pkce_verifier: string; nonce: string; used: number; expires_at: string }
    | undefined;

  if (!op || op.used !== 0 || new Date(op.expires_at) <= new Date()) {
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }

  // Extract user_id from nonce (format: "uid:<userId>:<random>")
  const nonceMatch = op.nonce.match(/^uid:(\d+):/);
  if (!nonceMatch) {
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }
  const userId = parseInt(nonceMatch[1], 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }

  // Fix 2: cross-check current session — the browser completing the callback must
  // belong to the same user who initiated the connect flow.
  const rawSessionToken =
    cookieHeader.match(/(?:^|;)\s*planner_session=([^;]+)/)?.[1] ?? null;
  if (rawSessionToken) {
    const tokenHash = createHash("sha256").update(rawSessionToken).digest("hex");
    const currentSession = db
      .prepare(
        `SELECT user_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      )
      .get(tokenHash) as { user_id: number } | undefined;
    if (!currentSession || currentSession.user_id !== userId) {
      return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
    }
  }

  // Mark operation as used atomically before doing anything else (prevent replay)
  const markResult = db
    .prepare(`UPDATE auth_operations SET used = 1 WHERE id = ? AND used = 0`)
    .run(op.id);
  if (markResult.changes === 0) {
    // Another request beat us — replay attempt
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }

  // Handle user-denied access
  if (errorParam === "access_denied") {
    if (isGoogleTasksConnectedForUser(userId)) {
      // Was already connected — treat as tasks permission denied
    }
    return redirectWithClear(
      oauthResultUrl(request.url, "google", "tasks-permission-required").href,
      clearStateCookie,
    );
  }

  if (!code) {
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }

  try {
    const result = await exchangeCode(code, op.pkce_verifier, userId);
    return redirectWithClear(
      oauthResultUrl(
        request.url,
        "google",
        result.tasksConnected ? "connected" : "tasks-permission-required",
      ).href,
      clearStateCookie,
    );
  } catch {
    return redirectWithClear(oauthResultUrl(request.url, "google", "error").href, clearStateCookie);
  }
}
