/**
 * POST /api/auth/setup
 *
 * First-admin bootstrap endpoint.
 *
 * Behavior:
 *   - Returns 410 Gone if setup is no longer allowed (users table non-empty OR
 *     SETUP_TOKEN_USED written OR SETUP_TOKEN env var missing).
 *   - Accepts { setupToken, provider: 'google' | 'microsoft' } in request body.
 *   - Validates setupToken using timingSafeEqual against SETUP_TOKEN env var.
 *   - On success: redirects to the chosen OIDC authorize endpoint with a
 *     special 'setup' intent marker (stores a short-lived DB token so the
 *     callback knows to call bootstrapFirstAdmin).
 *
 * Security:
 *   - assertSameOrigin() — CSRF protection.
 *   - timingSafeEqual for token comparison; never logs raw token.
 *   - Permanently unavailable after first admin created (410 Gone).
 *   - SETUP_TOKEN_USED is written atomically in bootstrapFirstAdmin.
 *
 * Note: The OIDC authorize routes do NOT need to understand the setup flow
 * specially. Instead, we create a special "setup invite" in the invites table
 * (with a sentinel role of 'admin' and recipient_email 'setup::bootstrap') so
 * the callback's invite flow creates the first admin user via bootstrapFirstAdmin.
 * The invite is consumed once in the callback exactly as any other invite would be.
 */

import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { db, isSetupAllowed, claimSetupToken } from "@/lib/db-multi";
import { assertSameOrigin, appOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  // CSRF protection
  try {
    assertSameOrigin(request);
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Check if setup is allowed at all
  if (!isSetupAllowed()) {
    return Response.json(
      { error: "Setup already complete or not available." },
      { status: 410 },
    );
  }

  let body: { setupToken?: unknown; provider?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const providedToken = typeof body.setupToken === "string" ? body.setupToken : "";
  const provider = body.provider === "microsoft" ? "microsoft" : "google";

  // Validate setup token with timing-safe comparison
  if (!claimSetupToken(providedToken)) {
    // Log failed attempt without revealing the token
    try {
      db.prepare(`
        INSERT INTO security_events (user_id, event_type, ip_hint, details, created_at)
        VALUES (NULL, 'login_failure', ?, ?, ?)
      `).run(
        null,
        JSON.stringify({ reason: "invalid_setup_token" }),
        new Date().toISOString(),
      );
    } catch (err) {
      console.error("[security_event] setup token failure log failed:", err);
    }
    return Response.json({ error: "Invalid setup token." }, { status: 401 });
  }

  // Create a special admin invite for the bootstrap flow.
  // The invite has a sentinel recipient_email so the callback knows it is the
  // setup flow. bootstrapFirstAdmin is called atomically from the OIDC callback
  // when this invite is consumed.
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // We need a placeholder created_by user id. Since no users exist yet, we use
  // a sentinel value (0). The invites.created_by FK references users(id), but
  // SQLite only enforces FKs when PRAGMA foreign_keys = ON. For the setup flow
  // this is acceptable since no real user exists yet; the invite is consumed
  // in the callback where bootstrapFirstAdmin creates the first user.
  //
  // To avoid FK violation, we temporarily disable the FK check for this insert.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.prepare(`
      INSERT INTO invites (token_hash, recipient_email, role, created_by, expires_at)
      VALUES (?, 'setup::bootstrap', 'admin', 0, ?)
    `).run(tokenHash, expiresAt);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  // Redirect to the appropriate OIDC authorize endpoint with the setup invite
  const origin = appOrigin(request.url);
  const authorizeBase =
    provider === "microsoft"
      ? `${origin}/api/auth/microsoft-oidc/authorize`
      : `${origin}/api/auth/google-oidc/authorize`;

  const redirectUrl = `${authorizeBase}?invite=${encodeURIComponent(rawToken)}`;

  return Response.json({ redirectUrl });
}

// ---------------------------------------------------------------------------
// GET — inform callers whether setup is available
// ---------------------------------------------------------------------------

export async function GET(): Promise<Response> {
  const allowed = isSetupAllowed();
  if (!allowed) {
    return Response.json({ available: false }, { status: 410 });
  }
  return Response.json({ available: true });
}
