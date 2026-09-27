/**
 * /api/admin/invites
 *
 * Admin-only invite management.
 *
 * GET  — list active invites (admin only)
 * POST — create recovery invite for specific user (admin only)
 *
 * Security:
 *   - assertSameOrigin() on ALL mutating routes (POST).
 *   - Admin role resolved from session cookie only.
 *   - Admin does NOT access other users' tasks, calendar data, or OAuth tokens.
 *   - Raw tokens returned once for out-of-band delivery; never stored in plaintext.
 */

import { requireUserContext, db } from "@/lib/db-multi";
import { createRecoveryInvite } from "@/lib/user-service";
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
// GET — list active (unused, non-expired) invites (admin only)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof requireUserContext>;
  try {
    ctx = requireAdmin(request);
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  void ctx;

  // token_hash is NOT returned — internal security field
  const invites = db.prepare(`
    SELECT
      i.id,
      i.recipient_email,
      i.role,
      i.created_by,
      i.expires_at,
      i.used_at,
      i.used_by,
      u.display_name AS created_by_name
    FROM invites i
    LEFT JOIN users u ON u.id = i.created_by
    ORDER BY i.expires_at DESC
    LIMIT 200
  `).all() as Array<{
    id: number;
    recipient_email: string | null;
    role: string;
    created_by: number;
    expires_at: string;
    used_at: string | null;
    used_by: number | null;
    created_by_name: string | null;
  }>;

  return Response.json({
    invites: invites.map((i) => ({
      id: i.id,
      recipientEmail: i.recipient_email,
      role: i.role,
      createdBy: i.created_by,
      createdByName: i.created_by_name,
      expiresAt: i.expires_at,
      usedAt: i.used_at,
      usedBy: i.used_by,
      active: i.used_at === null && new Date(i.expires_at) > new Date(),
      isRecovery: typeof i.recipient_email === "string" && i.recipient_email.startsWith("recovery::"),
    })),
  });
}

// ---------------------------------------------------------------------------
// POST — create recovery invite for specific user (admin only)
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

  let body: { targetUserId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const targetUserId =
    typeof body.targetUserId === "number" && body.targetUserId > 0
      ? body.targetUserId
      : null;

  if (!targetUserId) {
    return Response.json({ error: "targetUserId is required." }, { status: 400 });
  }

  let result: { rawToken: string };
  try {
    result = createRecoveryInvite(ctx.id, targetUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (message.endsWith("not found")) {
      return Response.json({ error: "Naudotojas nerastas." }, { status: 404 });
    }
    return Response.json({ error: `Nepavyko sukurti atkūrimo kvietimo: ${message}` }, { status: 500 });
  }

  // Log security event
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, 'account_recovery_created', NULL, ?, ?)
    `).run(
      ctx.id,
      JSON.stringify({ target_user_id: targetUserId }),
      new Date().toISOString(),
    );
  } catch (err) { console.error("[security_event] account_recovery_created log failed:", err); }

  const origin = appOrigin(request.url);

  return Response.json({
    // Raw token returned once for out-of-band delivery
    recoveryUrl: `${origin}/login?invite=${result.rawToken}`,
  });
}
