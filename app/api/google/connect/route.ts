import { createHash, randomBytes } from "node:crypto";
import { generatePKCE, googleAuthUrl, isGoogleConfigured } from "@/lib/google";
import { oauthResultUrl } from "@/lib/http";
import { requireUserContext, db } from "@/lib/db-multi";

export async function GET(request: Request) {
  // Require authenticated user — user identity from server-verified session only
  let user: { id: number; role: string };
  try {
    user = requireUserContext(request);
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }

  try {
    if (!isGoogleConfigured()) {
      return Response.redirect(oauthResultUrl(request.url, "google", "not-configured"));
    }

    const state = randomBytes(24).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const { verifier, challenge } = generatePKCE();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Store auth_operation server-side — tie to the current session and user_id
    // so the callback can look up the user without trusting any client-sent data
    const cookieHeader = request.headers.get("cookie") ?? "";
    const sessionTokenMatch = cookieHeader.match(/(?:^|;)\s*planner_session=([^;]+)/);
    const rawSessionToken = sessionTokenMatch?.[1] ?? null;

    // Find the session_id for this request
    let sessionId: number | null = null;
    if (rawSessionToken) {
      const tokenHash = createHash("sha256").update(rawSessionToken).digest("hex");
      const session = db
        .prepare(`SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`)
        .get(tokenHash) as { id: number } | undefined;
      sessionId = session?.id ?? null;
    }

    db.prepare(`
      INSERT INTO auth_operations
        (state_hash, nonce, pkce_verifier, provider, session_id, callback_path, expires_at, used)
      VALUES (?, ?, ?, 'google', ?, '/api/google/callback', ?, 0)
    `).run(stateHash, randomBytes(16).toString("hex"), verifier, sessionId, expiresAt);

    // Also store user_id in the operation for direct lookup in callback
    // auth_operations has no user_id column — we embed it in nonce field (safe: server-only)
    // Actually, we store it separately via a lightweight approach: include it in a signed state.
    // The cleanest approach: store user_id in the operation row via a custom column approach.
    // Since auth_operations has session_id which maps to user_id, the callback can join.
    // If there's no session (edge case), we use an alternative.
    // We'll add the user_id as the nonce prefix to recover it in the callback without a join:
    // Format: "uid:<userId>:<random_nonce>"
    db.prepare(`
      UPDATE auth_operations SET nonce = ? WHERE state_hash = ?
    `).run(`uid:${user.id}:${randomBytes(16).toString("hex")}`, stateHash);

    // Existing connection may have a login_hint
    const { getConnection } = await import("@/lib/oauth-service");
    const existing = getConnection(user.id, "google");
    const loginHint = existing?.provider_account_id ?? undefined;

    // Fix: bind state to this browser via an HttpOnly cookie so the callback can
    // verify that the response was initiated by the same browser (CSRF protection).
    const isSecure = new URL(request.url).protocol === "https:";
    // Use new Response instead of Response.redirect to avoid immutable headers
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleAuthUrl(state, challenge, loginHint),
        "Set-Cookie": `google_connect_state=${state}; Path=/api/google/callback; Max-Age=600; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`,
      },
    });
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }
}
