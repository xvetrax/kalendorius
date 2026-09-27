import { db, SESSION_COOKIE, revokeSession, revokeAllUserSessions } from "@/lib/db-multi";
import { createHash } from "node:crypto";
import { assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function POST(request: Request) {
  // CSRF protection on mutating route
  try {
    assertSameOrigin(request);
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const revokeAll = url.searchParams.get("all") === "1";

  // Resolve current session from cookie
  const cookieHeader = request.headers.get("cookie") ?? "";
  const rawToken = parseCookieValue(cookieHeader, SESSION_COOKIE);

  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);

    // Look up the session to get its id and user_id
    const session = db.prepare(`
      SELECT id, user_id FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash) as { id: number; user_id: number } | undefined;

    if (session) {
      if (revokeAll) {
        // Revoke all sessions for this user
        revokeAllUserSessions(session.user_id);

        // Log security event
        try {
          db.prepare(`
            INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
            VALUES (?, 'logout_all', ?, ?, ?)
          `).run(session.user_id, null, JSON.stringify({ via: "logout_all" }), nowIso());
        } catch (err) {
          console.error("[security_event] logout_all log failed:", err);
        }
      } else {
        // Revoke only the current session
        revokeSession(session.id);

        // Log security event
        try {
          db.prepare(`
            INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
            VALUES (?, 'logout', ?, ?, ?)
          `).run(session.user_id, null, JSON.stringify({ session_id: session.id }), nowIso());
        } catch (err) {
          console.error("[security_event] logout log failed:", err);
        }
      }
    }
  }

  // Clear the DB-backed multi-user session cookie.
  const resp = Response.json({ ok: true });
  resp.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return resp;
}
