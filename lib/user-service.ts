/**
 * lib/user-service.ts — User management service (H1)
 *
 * Security constraints (non-negotiable):
 *  - Admin role lets admin manage users but NOT access other users' tasks,
 *    calendar data, or OAuth tokens.
 *  - Every mutating function verifies the acting admin's identity via adminId.
 *  - Public registration creates a member from a verified OIDC issuer+subject.
 *  - Accounts are never merged automatically by matching email.
 */

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
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
// User management
// ---------------------------------------------------------------------------

export function isPublicSignupEnabled(): boolean {
  return process.env.PUBLIC_SIGNUP !== "false";
}

/**
 * findOrCreateOidcUser — resolves a verified OIDC identity or creates a new
 * isolated account.  Email is display metadata only and is never used to merge
 * identities.  The configured INITIAL_ADMIN_EMAIL can claim the first admin
 * role even if members registered earlier; without it, the first account is
 * admin for a convenient private bootstrap.
 */
export function findOrCreateOidcUser(input: {
  provider: "google" | "microsoft";
  issuer: string;
  subject: string;
  displayName: string;
  email: string;
}): { userId: number; role: "admin" | "member"; created: boolean } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      SELECT u.id, u.role
      FROM auth_identities ai
      JOIN users u ON u.id = ai.user_id
      WHERE ai.issuer = ? AND ai.subject = ?
    `).get(input.issuer, input.subject) as { id: number; role: "admin" | "member" } | undefined;
    if (existing) {
      db.exec("COMMIT");
      return { userId: existing.id, role: existing.role, created: false };
    }

    const userCount = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    const adminCount = countAdmins();
    const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLocaleLowerCase("en-US") ?? "";
    const normalizedEmail = input.email.trim().toLocaleLowerCase("en-US");
    const role: "admin" | "member" = adminCount === 0 && (
      initialAdminEmail ? normalizedEmail === initialAdminEmail : userCount === 0
    ) ? "admin" : "member";

    const userResult = db.prepare(`
      INSERT INTO users (display_name, primary_email, role, status, created_at, last_login_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(input.displayName || input.email, input.email, role, nowIso(), nowIso());
    const userId = Number(userResult.lastInsertRowid);

    db.prepare(`
      INSERT INTO auth_identities (user_id, provider, issuer, subject, display_email)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, input.provider, input.issuer, input.subject, input.email || null);

    db.exec("COMMIT");
    return { userId, role, created: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

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
