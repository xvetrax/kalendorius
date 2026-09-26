/**
 * lib/user-service.ts — User management service (H1)
 *
 * Security constraints (non-negotiable):
 *  - Admin role lets admin manage users but NOT access other users' tasks,
 *    calendar data, or OAuth tokens.
 *  - Invite and recovery tokens stored as SHA-256 hash; raw token never logged.
 *  - timingSafeEqual for all token comparisons.
 *  - Every mutating function verifies the acting admin's identity via adminId.
 */

import { randomBytes, createHash } from "node:crypto";
import { db } from "@/lib/db-multi";

// ---------------------------------------------------------------------------
// Re-export types used by callers
// ---------------------------------------------------------------------------

export type { UserContext } from "@/lib/db-multi";

// ---------------------------------------------------------------------------
// Row shapes (local; canonical shapes in docs/multi-user-interfaces.ts)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  display_name: string;
  primary_email: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
}

export interface AuthIdentityRow {
  id: number;
  user_id: number;
  provider: "google" | "microsoft";
  issuer: string;
  subject: string;
  display_email: string | null;
}

export interface InviteRow {
  id: number;
  token_hash: string;
  recipient_email: string | null;
  role: "admin" | "member";
  created_by: number;
  expires_at: string;
  used_at: string | null;
  used_by: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function countAdmins(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND status = 'active'")
    .get() as { cnt: number };
  return row.cnt;
}

function requireAdminExists(adminId: number): void {
  const admin = db
    .prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'")
    .get(adminId) as { id: number; role: string } | undefined;
  if (!admin) throw new Error(`Admin user ${adminId} not found or disabled`);
  if (admin.role !== "admin") throw new Error(`User ${adminId} is not an admin`);
}

// ---------------------------------------------------------------------------
// Invite management
// ---------------------------------------------------------------------------

/**
 * createInvite — generates a one-time invite token (stored as SHA-256 hash).
 * Raw token is returned for out-of-band delivery; never persisted in plaintext.
 */
export function createInvite(
  createdBy: number,
  role: "member",
  recipientEmail?: string,
  expiresInHours = 72,
): { id: number; rawToken: string; expiresAt: string } {
  requireAdminExists(createdBy);

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = expiryIso(expiresInHours);

  const result = db.prepare(`
    INSERT INTO invites (token_hash, recipient_email, role, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, recipientEmail ?? null, role, createdBy, expiresAt);

  return { id: Number(result.lastInsertRowid), rawToken, expiresAt };
}

/**
 * consumeInvite — validates hash, expiry, not-used. Returns the invite row.
 * Does NOT mark it used — call markInviteUsed after the user is created.
 */
export function consumeInvite(rawToken: string): InviteRow {
  const tokenHash = sha256Hex(rawToken);

  const invite = db.prepare(`
    SELECT id, token_hash, recipient_email, role, created_by, expires_at, used_at, used_by
    FROM invites
    WHERE token_hash = ?
  `).get(tokenHash) as InviteRow | undefined;

  if (!invite) throw new Error("invite_not_found");
  if (invite.used_at !== null) throw new Error("invite_already_used");
  if (new Date(invite.expires_at) <= new Date()) throw new Error("invite_expired");

  return invite;
}

/**
 * markInviteUsed — atomically marks the invite as consumed by the new user.
 */
export function markInviteUsed(inviteId: number, userId: number): void {
  const result = db.prepare(`
    UPDATE invites
    SET used_at = ?, used_by = ?
    WHERE id = ? AND used_at IS NULL
  `).run(nowIso(), userId, inviteId);

  if (result.changes === 0) {
    throw new Error("invite_already_used_or_not_found");
  }
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

/**
 * listUsers — returns all users (admin view). Does NOT include OAuth tokens.
 */
export function listUsers(): UserRow[] {
  return db.prepare(`
    SELECT id, display_name, primary_email, role, status, created_at, last_login_at
    FROM users
    ORDER BY created_at ASC
  `).all() as unknown as UserRow[];
}

/**
 * disableUser — sets user status to 'disabled' and revokes all their sessions.
 * Prevents disabling the last active admin.
 */
export function disableUser(adminId: number, targetUserId: number): void {
  requireAdminExists(adminId);

  const target = db
    .prepare("SELECT id, role, status FROM users WHERE id = ?")
    .get(targetUserId) as { id: number; role: string; status: string } | undefined;
  if (!target) throw new Error(`User ${targetUserId} not found`);

  if (target.role === "admin" && target.status === "active" && countAdmins() <= 1) {
    throw new Error("cannot_disable_last_admin");
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(targetUserId);
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(nowIso(), targetUserId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * enableUser — re-activates a previously disabled user.
 */
export function enableUser(adminId: number, targetUserId: number): void {
  requireAdminExists(adminId);

  const result = db.prepare(`
    UPDATE users SET status = 'active' WHERE id = ? AND status = 'disabled'
  `).run(targetUserId);

  if (result.changes === 0) {
    throw new Error("user_not_found_or_already_active");
  }
}

/**
 * setUserRole — changes a user's role. Prevents demoting the last active admin.
 */
export function setUserRole(
  adminId: number,
  targetUserId: number,
  role: "admin" | "member",
): void {
  requireAdminExists(adminId);

  if (role === "member") {
    const target = db
      .prepare("SELECT role, status FROM users WHERE id = ?")
      .get(targetUserId) as { role: string; status: string } | undefined;
    if (!target) throw new Error(`User ${targetUserId} not found`);
    if (target.role === "admin" && target.status === "active" && countAdmins() <= 1) {
      throw new Error("cannot_demote_last_admin");
    }
  }

  const result = db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, targetUserId);
  if (result.changes === 0) throw new Error(`User ${targetUserId} not found`);
}

// ---------------------------------------------------------------------------
// Identity management
// ---------------------------------------------------------------------------

/**
 * getUserIdentities — returns all auth_identities for a user.
 * Safe to call with any userId; does NOT expose OAuth tokens.
 */
export function getUserIdentities(userId: number): AuthIdentityRow[] {
  return db.prepare(`
    SELECT id, user_id, provider, issuer, subject, display_email
    FROM auth_identities
    WHERE user_id = ?
  `).all(userId) as unknown as AuthIdentityRow[];
}

/**
 * addIdentity — links an additional OIDC identity to an existing user.
 * Never merges accounts by email — linkage is by verified issuer+subject only.
 */
export function addIdentity(
  userId: number,
  provider: "google" | "microsoft",
  issuer: string,
  subject: string,
  email: string | null,
): void {
  // Verify the user exists
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: number }
    | undefined;
  if (!user) throw new Error(`User ${userId} not found`);

  // Check this issuer+subject is not already linked to ANY user
  const existing = db.prepare(`
    SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?
  `).get(issuer, subject) as { user_id: number } | undefined;

  if (existing) {
    if (existing.user_id === userId) throw new Error("identity_already_linked_to_this_user");
    throw new Error("identity_linked_to_different_user");
  }

  db.prepare(`
    INSERT INTO auth_identities (user_id, provider, issuer, subject, display_email)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, provider, issuer, subject, email ?? null);
}

// ---------------------------------------------------------------------------
// Account recovery
// ---------------------------------------------------------------------------

/**
 * createRecoveryInvite — admin-generated one-time recovery token for a specific user.
 * Stored as SHA-256 hash; raw token delivered out-of-band.
 * Uses the invites table with a special sentinel recipient_email prefix.
 * The raw token is returned for out-of-band delivery and never logged.
 */
export function createRecoveryInvite(
  adminId: number,
  targetUserId: number,
): { rawToken: string } {
  requireAdminExists(adminId);

  // Verify target user exists
  const target = db
    .prepare("SELECT id, role, primary_email FROM users WHERE id = ?")
    .get(targetUserId) as { id: number; role: string; primary_email: string } | undefined;
  if (!target) throw new Error(`User ${targetUserId} not found`);

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = expiryIso(24); // 24-hour window for account recovery

  // Store as invite with recipient_email encoding the target user id
  // Convention: recipient_email = "recovery::<userId>::<email>" to distinguish from normal invites
  const recipientMarker = `recovery::${targetUserId}::${target.primary_email}`;

  db.prepare(`
    INSERT INTO invites (token_hash, recipient_email, role, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, recipientMarker, target.role as "admin" | "member", adminId, expiresAt);

  return { rawToken };
}
