/**
 * /api/admin/users
 *
 * Admin-only user management.
 *
 * GET — list all users with identities and active session count (admin only)
 *
 * Security:
 *   - Admin role checked via session cookie; never from client-supplied userId.
 *   - Admin does NOT access other users' tasks, calendar data, or OAuth tokens.
 */

import { requireUserContext, db } from "@/lib/db-multi";

export const runtime = "nodejs";

function requireAdmin(request: Request) {
  const ctx = requireUserContext(request);
  if (ctx.role !== "admin") {
    throw new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// GET — list users (admin only)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof requireUserContext>;
  try {
    ctx = requireAdmin(request);
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Suppress unused variable warning
  void ctx;

  // Users with identity count and active session count
  // Admin does NOT access other users' tasks, calendar, or OAuth tokens
  const users = db.prepare(`
    SELECT
      u.id,
      u.display_name,
      u.primary_email,
      u.role,
      u.status,
      u.created_at,
      u.last_login_at,
      COUNT(DISTINCT ai.id) AS identity_count,
      COUNT(DISTINCT CASE WHEN s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP THEN s.id END) AS active_session_count
    FROM users u
    LEFT JOIN auth_identities ai ON ai.user_id = u.id
    LEFT JOIN sessions s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at ASC
  `).all() as Array<{
    id: number;
    display_name: string;
    primary_email: string;
    role: string;
    status: string;
    created_at: string;
    last_login_at: string | null;
    identity_count: number;
    active_session_count: number;
  }>;

  // Load identities for each user (provider + email only — no tokens)
  const identities = db.prepare(`
    SELECT user_id, provider, display_email
    FROM auth_identities
    ORDER BY user_id, id
  `).all() as Array<{ user_id: number; provider: string; display_email: string | null }>;

  const identitiesByUser = new Map<number, typeof identities>();
  for (const row of identities) {
    if (!identitiesByUser.has(row.user_id)) identitiesByUser.set(row.user_id, []);
    identitiesByUser.get(row.user_id)!.push(row);
  }

  return Response.json({
    users: users.map((u) => ({
      id: u.id,
      displayName: u.display_name,
      email: u.primary_email,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      identityCount: u.identity_count,
      activeSessionCount: u.active_session_count,
      identities: (identitiesByUser.get(u.id) ?? []).map((i) => ({
        provider: i.provider,
        email: i.display_email,
      })),
    })),
  });
}
