import { createHash, timingSafeEqual } from "node:crypto";
import { exchangeMicrosoftCode } from "@/lib/microsoft";
import { oauthResultUrl } from "@/lib/http";
import { db } from "@/lib/db-multi";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  const isSecure = url.protocol === "https:";
  const clearStateCookie = `microsoft_connect_state=; Path=/api/microsoft/callback; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`;

  if (!stateParam) {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  }

  // Fix 1: verify state is bound to this browser's cookie (CSRF protection)
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieState =
    cookieHeader.match(/(?:^|;)\s*microsoft_connect_state=([^;]+)/)?.[1] ?? null;
  if (!cookieState) {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  }
  const cs = Buffer.from(cookieState);
  const qs = Buffer.from(stateParam);
  if (cs.length !== qs.length || !timingSafeEqual(cs, qs)) {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  }

  // Look up the auth_operation by state hash
  const stateHash = createHash("sha256").update(stateParam).digest("hex");

  const op = db
    .prepare(`
      SELECT id, pkce_verifier, nonce, used, expires_at
      FROM auth_operations
      WHERE state_hash = ? AND provider = 'microsoft'
    `)
    .get(stateHash) as
    | { id: number; pkce_verifier: string; nonce: string; used: number; expires_at: string }
    | undefined;

  if (!op || op.used !== 0 || new Date(op.expires_at) <= new Date()) {
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  }

  // Extract user_id from nonce (format: "uid:<userId>:<random>")
  const nonceMatch = op.nonce.match(/^uid:(\d+):/);
  if (!nonceMatch) {
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  }
  const userId = parseInt(nonceMatch[1], 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
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
      const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
      resp.headers.append("Set-Cookie", clearStateCookie);
      return resp;
    }
  }

  // Mark operation as used atomically before doing anything else (prevent replay)
  const markResult = db
    .prepare(`UPDATE auth_operations SET used = 1 WHERE id = ? AND used = 0`)
    .run(op.id);
  if (markResult.changes === 0) {
    // Another request beat us — replay attempt
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  }

  if (!code) {
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  }

  try {
    await exchangeMicrosoftCode(code, op.pkce_verifier, userId);
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "connected"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  } catch {
    const resp = Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
    resp.headers.append("Set-Cookie", clearStateCookie);
    return resp;
  }
}
