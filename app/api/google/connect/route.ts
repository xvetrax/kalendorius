import { createHash, randomBytes } from "node:crypto";
import { generatePKCE, googleAuthUrl, isGoogleConfigured } from "@/lib/google";
import { oauthResultUrl } from "@/lib/http";
import { requireUserContext, db } from "@/lib/db-multi";
import {
  getConnectionById,
  listConnections,
  type OAuthConnectMode,
} from "@/lib/oauth-service";

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

    const url = new URL(request.url);
    const requestedMode = url.searchParams.get("mode");
    if (requestedMode !== null && requestedMode !== "add" && requestedMode !== "reconsent") {
      throw new Error("Invalid OAuth mode");
    }
    const active = listConnections(user.id, "google").filter((connection) => connection.status === "active");
    let mode: OAuthConnectMode;
    let expectedConnectionId: number | null = null;
    let loginHint: string | undefined;
    if (requestedMode === "add") {
      mode = "add";
      if (url.searchParams.has("connectionId")) throw new Error("Add mode cannot target a connection");
    } else if (requestedMode === null && active.length === 0) {
      // Bootstrap remains legacy so two overlapping first-connect callbacks
      // cannot both create different accounts. Only explicit mode=add may do so.
      mode = "legacy";
    } else {
      mode = "reconsent";
      const rawConnectionId = url.searchParams.get("connectionId");
      const connectionId = rawConnectionId === null && requestedMode === null && active.length === 1
        ? active[0]!.id
        : Number(rawConnectionId);
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
        throw new Error("Connection id required");
      }
      const connection = getConnectionById(user.id, connectionId, "google");
      if (!connection || connection.status !== "active") throw new Error("Connection not found");
      expectedConnectionId = connection.id;
      loginHint = connection.provider_email ?? connection.provider_account_id;
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

    if (sessionId === null) throw new Error("Active session row not found");
    db.prepare(`
      INSERT INTO auth_operations
        (state_hash, nonce, pkce_verifier, provider, session_id, callback_path,
         expires_at, used, oauth_mode, expected_connection_id)
      VALUES (?, ?, ?, 'google', ?, '/api/google/callback', ?, 0, ?, ?)
    `).run(
      stateHash,
      randomBytes(16).toString("hex"),
      verifier,
      sessionId,
      expiresAt,
      mode,
      expectedConnectionId,
    );

    // Fix: bind state to this browser via an HttpOnly cookie so the callback can
    // verify that the response was initiated by the same browser (CSRF protection).
    const isSecure = new URL(request.url).protocol === "https:";
    // Use new Response instead of Response.redirect to avoid immutable headers
    return new Response(null, {
      status: 302,
      headers: {
        Location: googleAuthUrl(state, challenge, loginHint, mode === "add"),
        "Set-Cookie": `google_connect_state=${state}; Path=/api/google/callback; Max-Age=600; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`,
      },
    });
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }
}
