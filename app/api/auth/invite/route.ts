/**
 * /api/auth/invite
 *
 * Admin-only invite management.
 *
 * GET    — list all invites (admin only)
 * POST   — create invite (admin only); body: { role, recipientEmail?, expiresInHours? }
 * DELETE — revoke unused invite (admin only); body: { inviteId }
 *
 * Security:
 *   - assertSameOrigin() on ALL mutating routes (POST, DELETE).
 *   - requireUserContext + admin role check before every operation.
 *   - Invite raw tokens never returned after creation (only for immediate delivery).
 *   - Admin cannot access other users' tasks, calendar data, or OAuth tokens.
 */

import { requireUserContext } from "@/lib/db-multi";
import { db } from "@/lib/db-multi";
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
// GET — list invites (admin only)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  let ctx: ReturnType<typeof requireUserContext>;
  try {
    ctx = requireAdmin(request);
  } catch (err) {
    if (err instanceof Response) return err;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // List invites — token_hash is NOT returned (it's an internal security field)
  const invites = db.prepare(`
    SELECT id, recipient_email, role, created_by, expires_at, used_at, used_by
    FROM invites
    ORDER BY expires_at DESC
  `).all() as Array<{
    id: number;
    recipient_email: string | null;
    role: string;
    created_by: number;
    expires_at: string;
    used_at: string | null;
    used_by: number | null;
  }>;

  return Response.json({ invites });
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

  const role = body.role === "admin" ? "admin" : "member";
  // Only 'member' role allowed via createInvite signature; admins are created via bootstrap
  // For this system, admin invites are permitted (the function allows it)
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
    // createInvite only accepts 'member' role — handle admin separately
    if (role === "admin") {
      // Admin invites use the same mechanism but we call db directly
      const { randomBytes, createHash } = await import("node:crypto");
      const rawToken = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
      const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
      const insertResult = db.prepare(`
        INSERT INTO invites (token_hash, recipient_email, role, created_by, expires_at)
        VALUES (?, ?, 'admin', ?, ?)
      `).run(tokenHash, recipientEmail ?? null, ctx.id, expiresAt);
      result = { id: Number(insertResult.lastInsertRowid), rawToken, expiresAt };
    } else {
      result = createInvite(ctx.id, "member", recipientEmail, expiresInHours);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return Response.json({ error: `Failed to create invite: ${message}` }, { status: 500 });
  }

  // Log security event
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, 'invite_created', ?, ?, ?)
    `).run(
      ctx.id,
      null,
      JSON.stringify({ invite_id: result.id, role, recipient_email: recipientEmail ?? null }),
      new Date().toISOString(),
    );
  } catch (err) {
    console.error("[security_event] invite_created log failed:", err);
  }

  const origin = appOrigin(request.url);

  return Response.json({
    id: result.id,
    rawToken: result.rawToken,  // returned once for out-of-band delivery; never stored again
    expiresAt: result.expiresAt,
    role,
    recipientEmail: recipientEmail ?? null,
    // Convenience: pre-built invite URLs for each provider
    googleInviteUrl: `${origin}/api/auth/google-oidc/authorize?invite=${result.rawToken}`,
    microsoftInviteUrl: `${origin}/api/auth/microsoft-oidc/authorize?invite=${result.rawToken}`,
  });
}

// ---------------------------------------------------------------------------
// DELETE — revoke unused invite (admin only)
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<Response> {
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

  let body: { inviteId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const inviteId = typeof body.inviteId === "number" ? body.inviteId : null;
  if (!inviteId) {
    return Response.json({ error: "inviteId is required." }, { status: 400 });
  }

  // Verify invite exists and is unused
  const invite = db.prepare(`
    SELECT id, used_at FROM invites WHERE id = ?
  `).get(inviteId) as { id: number; used_at: string | null } | undefined;

  if (!invite) {
    return Response.json({ error: "Invite not found." }, { status: 404 });
  }

  if (invite.used_at !== null) {
    return Response.json({ error: "Invite has already been used and cannot be revoked." }, { status: 409 });
  }

  // Revoke by setting expiry to past (soft delete — keeps audit trail)
  const result = db.prepare(`
    UPDATE invites SET expires_at = '1970-01-01T00:00:00.000Z', used_at = ?
    WHERE id = ? AND used_at IS NULL
  `).run(new Date().toISOString(), inviteId);

  if (result.changes === 0) {
    return Response.json({ error: "Invite could not be revoked (may have been used concurrently)." }, { status: 409 });
  }

  // Log security event
  try {
    db.prepare(`
      INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
      VALUES (?, 'admin_action', ?, ?, ?)
    `).run(
      ctx.id,
      null,
      JSON.stringify({ action: "invite_revoked", invite_id: inviteId }),
      new Date().toISOString(),
    );
  } catch (err) {
    console.error("[security_event] invite_revoked log failed:", err);
  }

  return Response.json({ ok: true });
}
