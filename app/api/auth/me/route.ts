/**
 * GET /api/auth/me
 *
 * Returns the current authenticated user's public profile.
 * No assertSameOrigin needed — GET, read-only.
 *
 * Security:
 *   - User identity resolved ONLY from server-verified DB session cookie.
 *   - Never returns OAuth tokens, session hashes, or other users' data.
 *   - Returns 401 if session is missing, expired, or revoked.
 */

import { requireUserContext, db } from "@/lib/db-multi";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof requireUserContext>;
  try {
    ctx = requireUserContext(request);
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load full user row — scoped to the resolved userId, never from client
  const user = db.prepare(`
    SELECT id, display_name, primary_email, role, status, created_at, last_login_at
    FROM users
    WHERE id = ? AND status = 'active'
  `).get(ctx.id) as {
    id: number;
    display_name: string;
    primary_email: string;
    role: string;
    status: string;
    created_at: string;
    last_login_at: string | null;
  } | undefined;

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const identities = (db.prepare(`
    SELECT provider, display_email FROM auth_identities WHERE user_id = ?
  `).all(ctx.id) as { provider: string; display_email: string | null }[]).map((row) => ({
    provider: row.provider,
    email: row.display_email,
  }));

  const now = new Date().toISOString();
  const activeSessionCount = (db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(ctx.id, now) as { count: number }).count;

  return Response.json({
    id: user.id,
    displayName: user.display_name,
    email: user.primary_email,
    role: user.role,
    identities,
    activeSessionCount,
  });
}
