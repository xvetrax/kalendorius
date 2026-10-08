/**
 * /api/admin/users/[userId]
 *
 * Admin-only per-user operations.
 *
 * PATCH  — change role or status (admin only, assertSameOrigin)
 * DELETE — disable user (admin only, assertSameOrigin)
 *
 * Security:
 *   - assertSameOrigin() on ALL mutating routes.
 *   - Admin role resolved from session; userId comes from URL path — still
 *     subject to ownership checks inside service functions.
 *   - Admin does NOT access other users' tasks, calendar data, or OAuth tokens.
 *   - Last active admin protection enforced in service layer.
 */

import { requireUserContext, db } from "@/lib/db-multi";
import { disableUser, enableUser, setUserRole } from "@/lib/user-service";
import { assertSameOrigin } from "@/lib/http";

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

async function parseUserId(params: Promise<{ userId: string }>): Promise<number | null> {
  const resolved = await params;
  const n = parseInt(resolved.userId, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// PATCH — update role or status
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
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

  const targetUserId = await parseUserId(params);
  if (!targetUserId) {
    return Response.json({ error: "Invalid userId." }, { status: 400 });
  }

  let body: { role?: unknown; status?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Handle role change
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "member") {
      return Response.json({ error: "role must be 'admin' or 'member'." }, { status: 400 });
    }
    try {
      setUserRole(ctx.id, targetUserId, body.role as "admin" | "member");
      // Log admin action
      try {
        db.prepare(`
          INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
          VALUES (?, 'admin_action', NULL, ?, ?)
        `).run(
          ctx.id,
          JSON.stringify({ action: "set_role", target_user_id: targetUserId, role: body.role }),
          new Date().toISOString(),
        );
      } catch (err) { console.error("[security_event] set_role log failed:", err); }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message === "cannot_demote_last_admin") {
        return Response.json({ error: "Negalima pažeminti paskutinio aktyvaus administratoriaus." }, { status: 409 });
      }
      if (message.startsWith("User ") && message.endsWith("not found")) {
        return Response.json({ error: "Naudotojas nerastas." }, { status: 404 });
      }
      return Response.json({ error: `Nepavyko pakeisti rolės: ${message}` }, { status: 500 });
    }
  }

  // Handle status change
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      return Response.json({ error: "status must be 'active' or 'disabled'." }, { status: 400 });
    }
    try {
      if (body.status === "disabled") {
        disableUser(ctx.id, targetUserId);
        try {
          db.prepare(`
            INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
            VALUES (?, 'account_disabled', NULL, ?, ?)
          `).run(
            ctx.id,
            JSON.stringify({ target_user_id: targetUserId }),
            new Date().toISOString(),
          );
        } catch (err) { console.error("[security_event] account_disabled log failed:", err); }
      } else {
        enableUser(ctx.id, targetUserId);
        try {
          db.prepare(`
            INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
            VALUES (?, 'account_enabled', NULL, ?, ?)
          `).run(
            ctx.id,
            JSON.stringify({ target_user_id: targetUserId }),
            new Date().toISOString(),
          );
        } catch (err) { console.error("[security_event] account_enabled log failed:", err); }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message === "cannot_disable_last_admin") {
        return Response.json({ error: "Negalima išjungti paskutinio aktyvaus administratoriaus." }, { status: 409 });
      }
      return Response.json({ error: `Nepavyko pakeisti būsenos: ${message}` }, { status: 500 });
    }
  }

  // Return updated user row
  const updated = db.prepare(`
    SELECT id, display_name, primary_email, role, status FROM users WHERE id = ?
  `).get(targetUserId) as {
    id: number; display_name: string; primary_email: string; role: string; status: string;
  } | undefined;

  return Response.json({ ok: true, user: updated ?? null });
}

// ---------------------------------------------------------------------------
// DELETE — disable user (soft delete — keeps audit trail)
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
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

  const targetUserId = await parseUserId(params);
  if (!targetUserId) {
    return Response.json({ error: "Invalid userId." }, { status: 400 });
  }

  try {
    disableUser(ctx.id, targetUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (message === "cannot_disable_last_admin") {
      return Response.json({ error: "Negalima išjungti paskutinio aktyvaus administratoriaus." }, { status: 409 });
    }
    if (message.startsWith("User ") && message.endsWith("not found")) {
      return Response.json({ error: "Naudotojas nerastas." }, { status: 404 });
    }
    return Response.json({ error: `Nepavyko išjungti naudotojo: ${message}` }, { status: 500 });
  }

  // Log security event
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, 'account_disabled', NULL, ?, ?)
    `).run(
      ctx.id,
      JSON.stringify({ action: "admin_disable", target_user_id: targetUserId }),
      new Date().toISOString(),
    );
  } catch (err) { console.error("[security_event] account_disabled log failed:", err); }

  return Response.json({ ok: true });
}
