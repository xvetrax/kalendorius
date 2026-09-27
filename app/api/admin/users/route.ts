/**
 * /api/admin/users
 *
 * Admin-only user management.
 *
 * GET  — list all users with identities and active session count (admin only)
 * POST — create invite { role, recipientEmail? } (admin only)
 *
 * Security:
 *   - assertSameOrigin() on ALL mutating routes (POST).
 *   - Admin role checked via session cookie; never from client-supplied userId.
 *   - Admin does NOT access other users' tasks, calendar data, or OAuth tokens.
 *   - Invite raw tokens returned once for out-of-band delivery; never logged.
 */

import { requireUserContext, db } from "@/lib/db-multi";
import { createInvite } from "@/lib/user-service";
import { assertSameOrigin, appOrigin } from "@/lib/http";

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

// ---------------------------------------------------------------------------
// POST — create invite (admin only)
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  // CSRF protection
  try {
    assertSameOrigin(request);
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let ctx: ReturnType<typeof requireUserContext>;
  try {
    ctx = requireAdmin(request);
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { role?: unknown; recipientEmail?: unknown; expiresInHours?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const recipientEmail =
    typeof body.recipientEmail === "string" && body.recipientEmail.trim()
      ? body.recipientEmail.trim()
      : undefined;
  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0 && body.expiresInHours <= 720
      ? Math.floor(body.expiresInHours)
      : 72;

  let result: { id: number; rawToken: string; expiresAt: string };
  try {
    // createInvite only accepts 'member' — per plan, new users join as members
    result = createInvite(ctx.id, "member", recipientEmail, expiresInHours);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return Response.json({ error: `Nepavyko sukurti kvietimo: ${message}` }, { status: 500 });
  }

  // Log security event
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, 'invite_created', NULL, ?, ?)
    `).run(
      ctx.id,
      JSON.stringify({ invite_id: result.id, recipient_email: recipientEmail ?? null }),
      new Date().toISOString(),
    );
  } catch (err) {
    console.error("[security_event] invite_created log failed:", err);
  }

  const origin = appOrigin(request.url);

  return Response.json({
    id: result.id,
    expiresAt: result.expiresAt,
    recipientEmail: recipientEmail ?? null,
    // Pre-built invite URLs — raw token returned once for immediate delivery
    googleInviteUrl: `${origin}/login?invite=${result.rawToken}`,
    microsoftInviteUrl: `${origin}/login?invite=${result.rawToken}`,
    inviteUrl: `${origin}/login?invite=${result.rawToken}`,
  });
}
