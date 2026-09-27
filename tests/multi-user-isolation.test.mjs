/**
 * tests/multi-user-isolation.test.mjs — H7 Security isolation tests
 *
 * Tests: DB isolation, API isolation, cross-user ID probing, missing auth,
 * OAuth connection isolation, invite flow, session revocation,
 * last-admin protection, setup endpoint lock-down.
 *
 * Pattern: ESM, node:test + node:assert, same as existing test suite.
 */

import assert from "node:assert/strict";
import { test, after, before } from "node:test";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Env setup — isolated temp DB; must happen before any lib import
// ---------------------------------------------------------------------------

const temp = mkdtempSync(path.join(tmpdir(), "planner-isolation-"));
const dbFile = path.join(temp, "test.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.APP_ORIGIN = "http://localhost:3000";
// Provide a SETUP_TOKEN so isSetupAllowed() can work in tests
process.env.SETUP_TOKEN = "super-secret-setup-token-for-tests";
for (const provider of ["GOOGLE", "MICROSOFT"]) {
  process.env[`${provider}_CLIENT_ID`] = "synthetic-client";
  process.env[`${provider}_CLIENT_SECRET`] = "synthetic-secret";
  process.env[`${provider}_REDIRECT_URI`] = `http://localhost:3000/api/${provider.toLowerCase()}/callback`;
}

// ---------------------------------------------------------------------------
// Module hooks: resolve @/ aliases
// ---------------------------------------------------------------------------

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith("@/")
        ? pathToFileURL(path.resolve(import.meta.dirname, "..", specifier.slice(2) + ".ts")).href
        : specifier,
      context,
    );
  },
});

// ---------------------------------------------------------------------------
// Import lib modules after env is configured
// ---------------------------------------------------------------------------

const {
  db,
  createSession,
  getUserFromSession,
  revokeSession,
  revokeAllUserSessions,
  isSetupAllowed,
  claimSetupToken,
  bootstrapFirstAdmin,
  SESSION_COOKIE,
} = await import("../lib/db-multi.ts");

const {
  createInvite,
  consumeInvite,
  markInviteUsed,
  disableUser,
  setUserRole,
  listUsers,
} = await import("../lib/user-service.ts");

const {
  getConnection,
  listConnections,
  saveConnection,
  deleteConnection,
} = await import("../lib/oauth-service.ts");

const { encrypt } = await import("../lib/secrets.ts");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

after(() => {
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertUser(displayName, email, role = "member") {
  const result = db
    .prepare(
      "INSERT INTO users (display_name, primary_email, role, status, created_at) VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)",
    )
    .run(displayName, email, role);
  return Number(result.lastInsertRowid);
}

function insertTask(userId, title = "Task") {
  const result = db
    .prepare(
      "INSERT INTO tasks (user_id, title) VALUES (?, ?)",
    )
    .run(userId, title);
  return Number(result.lastInsertRowid);
}

function getTask(taskId, userId) {
  return db
    .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
    .get(taskId, userId);
}

function getTaskAny(taskId) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
}

// ---------------------------------------------------------------------------
// Test: (a) DB isolation — user B cannot read user A's tasks via DB query
// ---------------------------------------------------------------------------

test("DB isolation: user B cannot read user A's tasks via user-scoped query", () => {
  const userA = insertUser("User A", "a@test.example", "member");
  const userB = insertUser("User B", "b@test.example", "member");

  const taskId = insertTask(userA, "Secret task for A");

  // A can read own task
  const taskForA = getTask(taskId, userA);
  assert.ok(taskForA, "User A should be able to read own task");
  assert.equal(taskForA.title, "Secret task for A");

  // B cannot read A's task via scoped query (WHERE user_id = B)
  const taskForB = getTask(taskId, userB);
  assert.equal(taskForB, undefined, "User B must not see user A's task via scoped query");

  // The task does exist in DB (unscoped) — confirms isolation is query-level not deletion
  const raw = getTaskAny(taskId);
  assert.ok(raw, "Task exists in DB");
  assert.equal(raw.user_id, userA, "Task belongs to user A");
});

// ---------------------------------------------------------------------------
// Test: (b) task_plans isolation
// ---------------------------------------------------------------------------

test("DB isolation: user B cannot read user A's task_plans via user-scoped query", () => {
  const userA = insertUser("Plan User A", "plana@test.example");
  const userB = insertUser("Plan User B", "planb@test.example");

  db.prepare(
    "INSERT INTO task_plans (user_id, task_key) VALUES (?, ?)",
  ).run(userA, "a-plan-key");

  const planForA = db
    .prepare("SELECT * FROM task_plans WHERE user_id = ? AND task_key = ?")
    .get(userA, "a-plan-key");
  assert.ok(planForA, "User A sees own plan");

  const planForB = db
    .prepare("SELECT * FROM task_plans WHERE user_id = ? AND task_key = ?")
    .get(userB, "a-plan-key");
  assert.equal(planForB, undefined, "User B must not see user A's plan");
});

// ---------------------------------------------------------------------------
// Test: (c) cross-user ID probing via getUserFromSession returns correct owner
// ---------------------------------------------------------------------------

test("Session isolation: sessions are scoped to their owner", () => {
  const userA = insertUser("Session A", "sessa@test.example");
  const userB = insertUser("Session B", "sessb@test.example");

  const { rawToken: tokenA } = createSession(userA);
  const { rawToken: tokenB } = createSession(userB);

  const ctxA = getUserFromSession(tokenA);
  const ctxB = getUserFromSession(tokenB);

  assert.ok(ctxA, "Session A should resolve");
  assert.equal(ctxA.id, userA, "Session A resolves to user A");

  assert.ok(ctxB, "Session B should resolve");
  assert.equal(ctxB.id, userB, "Session B resolves to user B");

  // Using B's token must not return A's context
  assert.notEqual(ctxB.id, userA, "Session B must not resolve as user A");
  // Using A's token must not return B's context
  assert.notEqual(ctxA.id, userB, "Session A must not resolve as user B");
});

// ---------------------------------------------------------------------------
// Test: (d) missing / invalid session returns null (API layer maps to 401)
// ---------------------------------------------------------------------------

test("Auth: missing session token returns null from getUserFromSession", () => {
  const result = getUserFromSession("totally-invalid-token-that-does-not-exist");
  assert.equal(result, null, "Invalid token must return null");
});

test("Auth: empty string token returns null", () => {
  const result = getUserFromSession("");
  assert.equal(result, null, "Empty token must return null");
});

// ---------------------------------------------------------------------------
// Test: requireUserContext throws 401 Response for missing cookie
// ---------------------------------------------------------------------------

test("requireUserContext: missing cookie throws 401 Response", async () => {
  const { requireUserContext } = await import("../lib/db-multi.ts");
  const req = new Request("http://localhost:3000/api/tasks");

  let threw = false;
  try {
    requireUserContext(req);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof Response, "Must throw a Response");
    assert.equal(e.status, 401, "Status must be 401");
  }
  assert.ok(threw, "Should have thrown");
});

test("requireUserContext: wrong session cookie throws 401 Response", async () => {
  const { requireUserContext } = await import("../lib/db-multi.ts");
  const req = new Request("http://localhost:3000/api/tasks", {
    headers: { Cookie: `${SESSION_COOKIE}=bad-token-value` },
  });

  let threw = false;
  try {
    requireUserContext(req);
  } catch (e) {
    threw = true;
    assert.ok(e instanceof Response, "Must throw a Response");
    assert.equal(e.status, 401, "Status must be 401");
  }
  assert.ok(threw, "Should have thrown");
});

// ---------------------------------------------------------------------------
// Test: (e) OAuth connection isolation — user B cannot access user A's token
// ---------------------------------------------------------------------------

test("OAuth isolation: getConnection filters by userId", () => {
  const userA = insertUser("OAuth A", "oautha@test.example");
  const userB = insertUser("OAuth B", "oauthb@test.example");

  const encToken = encrypt("secret-refresh-token-for-A");
  saveConnection(userA, "google", "provider-acc-A", "a@google.example", encToken, "openid email");

  // A sees own connection
  const connA = getConnection(userA, "google");
  assert.ok(connA, "User A should see own google connection");
  assert.equal(connA.user_id, userA, "Connection belongs to A");
  assert.equal(connA.provider_account_id, "provider-acc-A");

  // B sees no connection (none was created for B)
  const connB = getConnection(userB, "google");
  assert.equal(connB, null, "User B must not see user A's connection");
});

test("OAuth isolation: listConnections only returns connections for the requested user", () => {
  const userA = insertUser("List OAuth A", "listoautha@test.example");
  const userB = insertUser("List OAuth B", "listoauthb@test.example");

  saveConnection(userA, "microsoft", "ms-acc-A", "a@ms.example", encrypt("ms-token-A"), "openid");
  saveConnection(userB, "microsoft", "ms-acc-B", "b@ms.example", encrypt("ms-token-B"), "openid");

  const connsA = listConnections(userA);
  const connsB = listConnections(userB);

  assert.ok(
    connsA.every((c) => c.user_id === userA),
    "All connections returned for A must belong to A",
  );
  assert.ok(
    connsB.every((c) => c.user_id === userB),
    "All connections returned for B must belong to B",
  );

  // B's connection list must not contain any of A's provider_account_ids
  const bAccountIds = connsB.map((c) => c.provider_account_id);
  assert.ok(
    !bAccountIds.includes("ms-acc-A"),
    "B's connections must not include A's provider account",
  );
});

test("OAuth isolation: deleteConnection only deletes for the specified user", () => {
  const userA = insertUser("Del OAuth A", "deloautha@test.example");
  const userB = insertUser("Del OAuth B", "deloauthb@test.example");

  saveConnection(userA, "google", "del-acc-A", null, encrypt("del-token-A"), "openid");
  saveConnection(userB, "google", "del-acc-B", null, encrypt("del-token-B"), "openid");

  // Deleting with B's userId must not delete A's connection
  deleteConnection(userB, "google");

  const connA = getConnection(userA, "google");
  assert.ok(connA, "User A's connection must remain after B deletes their own");
  assert.equal(connA.provider_account_id, "del-acc-A");
});

// ---------------------------------------------------------------------------
// Test: (f) Invite flow — single use, cannot be reused
// ---------------------------------------------------------------------------

test("Invite flow: invite can be consumed once then is rejected", () => {
  // Need an admin user to create invite
  const adminId = insertUser("Admin For Invite", "admin.invite@test.example", "admin");

  const { id: inviteId, rawToken } = createInvite(adminId, "member", "friend@test.example", 72);
  assert.ok(inviteId > 0, "Invite ID should be positive");
  assert.ok(rawToken.length >= 32, "Raw token should be at least 32 chars");

  // Consume invite — should succeed
  const invite = consumeInvite(rawToken);
  assert.equal(invite.id, inviteId);
  assert.equal(invite.used_at, null, "Not yet marked used");

  // Create new user from invite
  const newUserId = insertUser("New Member", "newmember@test.example", "member");
  markInviteUsed(inviteId, newUserId);

  // Second use must throw
  let threw = false;
  try {
    consumeInvite(rawToken);
  } catch (e) {
    threw = true;
    assert.match(e.message, /invite_already_used/, "Error must indicate invite already used");
  }
  assert.ok(threw, "Second consumeInvite must throw");
});

test("Invite flow: non-existent token is rejected", () => {
  let threw = false;
  try {
    consumeInvite("0000000000000000000000000000000000000000000000000000000000000000");
  } catch (e) {
    threw = true;
    assert.match(e.message, /invite_not_found/);
  }
  assert.ok(threw, "Non-existent invite token must throw invite_not_found");
});

test("Invite flow: expired invite is rejected", () => {
  const adminId = insertUser("Admin Expired", "admin.expired@test.example", "admin");
  const { id: inviteId, rawToken } = createInvite(adminId, "member", undefined, 72);

  // Manually expire it
  db.prepare("UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(inviteId);

  let threw = false;
  try {
    consumeInvite(rawToken);
  } catch (e) {
    threw = true;
    assert.match(e.message, /invite_expired/);
  }
  assert.ok(threw, "Expired invite must throw");
});

// ---------------------------------------------------------------------------
// Test: (g) Session revocation — revoked session returns null
// ---------------------------------------------------------------------------

test("Session revocation: revokeSession makes session invalid", () => {
  const userId = insertUser("Revoke User", "revoke@test.example");
  const { rawToken, sessionId } = createSession(userId);

  // Valid before revocation
  const ctxBefore = getUserFromSession(rawToken);
  assert.ok(ctxBefore, "Session should be valid before revocation");

  revokeSession(sessionId);

  // Invalid after revocation
  const ctxAfter = getUserFromSession(rawToken);
  assert.equal(ctxAfter, null, "Revoked session must return null");
});

test("Session revocation: revokeAllUserSessions invalidates all sessions for a user", () => {
  const userId = insertUser("Revoke All User", "revokeall@test.example");
  const { rawToken: token1 } = createSession(userId);
  const { rawToken: token2 } = createSession(userId);

  assert.ok(getUserFromSession(token1), "Session 1 valid before revocation");
  assert.ok(getUserFromSession(token2), "Session 2 valid before revocation");

  revokeAllUserSessions(userId);

  assert.equal(getUserFromSession(token1), null, "Session 1 must be revoked");
  assert.equal(getUserFromSession(token2), null, "Session 2 must be revoked");
});

test("Session revocation: revoking one user's sessions does not affect another user's sessions", () => {
  const userA = insertUser("Revoke A", "revokea@test.example");
  const userB = insertUser("Revoke B", "revokeb@test.example");

  const { rawToken: tokenA } = createSession(userA);
  const { rawToken: tokenB } = createSession(userB);

  revokeAllUserSessions(userA);

  assert.equal(getUserFromSession(tokenA), null, "User A's session is revoked");
  assert.ok(getUserFromSession(tokenB), "User B's session must remain active");
});

// ---------------------------------------------------------------------------
// Test: (h) Last admin protection — cannot disable or demote the only admin
//
// These tests need exactly one active admin to trigger the protection.
// We temporarily disable all OTHER admins, run the test, then restore them.
// ---------------------------------------------------------------------------

/**
 * Returns the IDs of all currently active admins except `exceptId`.
 */
function getOtherActiveAdmins(exceptId) {
  return db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id != ?")
    .all(exceptId)
    .map((r) => r.id);
}

/**
 * Directly set status to 'disabled' in DB, bypassing the service layer protection.
 * Used only to set up the test precondition.
 */
function rawDisable(userId) {
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
}

/**
 * Directly re-enable user.
 */
function rawEnable(userId) {
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(userId);
}

test("Last admin protection: disableUser throws when only one admin exists", () => {
  const adminId = insertUser("Sole Admin", "soleadmin@test.example", "admin");

  // Ensure this is the only active admin in the DB
  const others = getOtherActiveAdmins(adminId);
  for (const id of others) rawDisable(id);

  let threw = false;
  try {
    disableUser(adminId, adminId);
  } catch (e) {
    threw = true;
    assert.match(e.message, /cannot_disable_last_admin/);
  }

  // Restore others
  for (const id of others) rawEnable(id);

  assert.ok(threw, "Should not be able to disable the last active admin");
});

test("Last admin protection: setUserRole to member throws when only one admin", () => {
  const adminId = insertUser("Sole Admin2", "soleadmin2@test.example", "admin");

  // Ensure this is the only active admin
  const others = getOtherActiveAdmins(adminId);
  for (const id of others) rawDisable(id);

  let threw = false;
  try {
    setUserRole(adminId, adminId, "member");
  } catch (e) {
    threw = true;
    assert.match(e.message, /cannot_demote_last_admin/);
  }

  // Restore others
  for (const id of others) rawEnable(id);

  assert.ok(threw, "Should not be able to demote the last active admin");
});

test("Last admin protection: second admin can be disabled when two admins exist", () => {
  const admin1 = insertUser("Admin One", "adminone@test.example", "admin");
  const admin2 = insertUser("Admin Two", "admintwo@test.example", "admin");

  // Should succeed — admin1 is still an admin
  let threw = false;
  try {
    disableUser(admin1, admin2);
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, "Should be able to disable second admin when two admins exist");
});

// ---------------------------------------------------------------------------
// Test: (i) Setup endpoint disabled after first admin created
// ---------------------------------------------------------------------------

test("isSetupAllowed: returns true when users table is empty and SETUP_TOKEN is set", () => {
  // The DB might already have users from other tests — check the actual state
  const count = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  const setupUsed = db
    .prepare("SELECT value FROM settings WHERE key = 'SETUP_TOKEN_USED'")
    .get();

  if (count === 0 && !setupUsed && process.env.SETUP_TOKEN) {
    assert.equal(isSetupAllowed(), true, "Setup should be allowed with empty DB");
  } else {
    // DB already has users from prior tests — setup should NOT be allowed
    assert.equal(isSetupAllowed(), false, "Setup should not be allowed when users exist");
  }
});

test("isSetupAllowed: returns false when SETUP_TOKEN env is unset", () => {
  const saved = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  try {
    assert.equal(isSetupAllowed(), false);
  } finally {
    process.env.SETUP_TOKEN = saved;
  }
});

test("bootstrapFirstAdmin / isSetupAllowed: after bootstrap, setup is no longer allowed", () => {
  // Use fresh in-memory path by checking behavior — bootstrapFirstAdmin checks internally
  // We test with the real DB; if users exist the function throws
  const count = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;

  if (count === 0) {
    // Can only run this sub-test when DB is pristine; if so, do bootstrap
    const { userId } = bootstrapFirstAdmin(
      "https://accounts.google.com",
      "sub-bootstrap-test",
      "Bootstrap Admin",
      "bootstrap@test.example",
    );
    assert.ok(userId > 0, "Admin user should be created");
    assert.equal(isSetupAllowed(), false, "Setup must not be allowed after bootstrap");
  } else {
    // DB already has users — bootstrapFirstAdmin should throw
    let threw = false;
    try {
      bootstrapFirstAdmin(
        "https://accounts.google.com",
        "sub-should-fail",
        "Duplicate Admin",
        "dup@test.example",
      );
    } catch (e) {
      threw = true;
      assert.match(e.message, /not empty|SETUP_TOKEN_USED/);
    }
    assert.ok(threw, "bootstrapFirstAdmin must throw when users already exist");
    assert.equal(isSetupAllowed(), false, "Setup must remain disallowed");
  }
});

test("claimSetupToken: wrong token returns false", () => {
  const result = claimSetupToken("definitely-wrong-token");
  // Will be false either because users exist or because token doesn't match
  assert.equal(result, false, "Wrong setup token must return false");
});

// ---------------------------------------------------------------------------
// Test: user_settings isolation — one user cannot read another's settings
// ---------------------------------------------------------------------------

test("user_settings isolation: settings are scoped per user", () => {
  const userA = insertUser("Settings A", "settingsa@test.example");
  const userB = insertUser("Settings B", "settingsb@test.example");

  db.prepare(
    "INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
  ).run(userA, "planner-theme", "dark");

  const settingForA = db
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .get(userA, "planner-theme");
  assert.ok(settingForA, "User A should see own setting");
  assert.equal(settingForA.value, "dark");

  const settingForB = db
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .get(userB, "planner-theme");
  assert.equal(settingForB, undefined, "User B must not see User A's settings");
});

// ---------------------------------------------------------------------------
// Test: task_key uniqueness is per-user, not global
// ---------------------------------------------------------------------------

test("DB schema: same task_key can exist for different users (per-user unique constraint)", () => {
  const userA = insertUser("Key Unique A", "keyuniqA@test.example");
  const userB = insertUser("Key Unique B", "keyuniqB@test.example");

  db.prepare("INSERT INTO task_plans (user_id, task_key) VALUES (?, ?)").run(userA, "shared-key");
  // Should NOT throw — same task_key is allowed for a different user_id
  let threw = false;
  try {
    db.prepare("INSERT INTO task_plans (user_id, task_key) VALUES (?, ?)").run(userB, "shared-key");
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, "Same task_key for different users should be allowed");

  // But same user cannot have two plans with same key
  let throwsDup = false;
  try {
    db.prepare("INSERT INTO task_plans (user_id, task_key) VALUES (?, ?)").run(userA, "shared-key");
  } catch (e) {
    throwsDup = true;
  }
  assert.ok(throwsDup, "Duplicate task_key for the same user must throw");
});

// ---------------------------------------------------------------------------
// Test: disabled user sessions are revoked on access
// ---------------------------------------------------------------------------

test("Disabled user: session returns null after user is disabled", () => {
  const adminId = insertUser("Admin Disabler", "adminDisabler@test.example", "admin");
  const memberId = insertUser("Member To Disable", "membertodisable@test.example", "member");

  const { rawToken } = createSession(memberId);
  assert.ok(getUserFromSession(rawToken), "Session valid before disable");

  disableUser(adminId, memberId);

  // After disabling, getUserFromSession should find user is not active and return null
  const ctx = getUserFromSession(rawToken);
  assert.equal(ctx, null, "Disabled user's session must return null");
});

// ---------------------------------------------------------------------------
// Test: foreign key enforcement — tasks cannot reference non-existent user
// ---------------------------------------------------------------------------

test("DB schema: tasks require valid user_id (foreign key enforced)", () => {
  let threw = false;
  try {
    db.prepare("INSERT INTO tasks (user_id, title) VALUES (?, ?)").run(999999, "Orphan task");
  } catch (e) {
    threw = true;
    // SQLite FK violation
    assert.match(e.message, /FOREIGN KEY|constraint/i);
  }
  assert.ok(threw, "Inserting task with non-existent user_id must throw");
});

// ---------------------------------------------------------------------------
// Test: OAuth token encryption — stored value is not plaintext
// ---------------------------------------------------------------------------

test("OAuth tokens: stored encrypted_refresh_token is not plaintext", () => {
  const userId = insertUser("Enc User", "encuser@test.example");
  const plainToken = "plain-text-refresh-token-value";
  saveConnection(userId, "google", "enc-account", null, encrypt(plainToken), "openid");

  const row = db
    .prepare("SELECT encrypted_refresh_token FROM oauth_connections WHERE user_id = ? AND provider = 'google'")
    .get(userId);

  assert.ok(row, "Connection row should exist");
  assert.notEqual(row.encrypted_refresh_token, plainToken, "Stored token must not be plaintext");
  // Should be in the format: base64url.base64url.base64url (iv.tag.ciphertext)
  const parts = row.encrypted_refresh_token.split(".");
  assert.equal(parts.length, 3, "Encrypted token should have 3 parts (iv.tag.ciphertext)");
});

// ---------------------------------------------------------------------------
// Test: listUsers does not expose OAuth tokens
// ---------------------------------------------------------------------------

test("listUsers: does not include OAuth tokens or session tokens in results", () => {
  const users = listUsers();
  assert.ok(Array.isArray(users), "listUsers should return an array");
  for (const user of users) {
    assert.ok(!("encrypted_refresh_token" in user), "listUsers must not expose refresh tokens");
    assert.ok(!("token_hash" in user), "listUsers must not expose session token hashes");
    // Required fields
    assert.ok("id" in user, "User must have id");
    assert.ok("display_name" in user, "User must have display_name");
    assert.ok("role" in user, "User must have role");
    assert.ok("status" in user, "User must have status");
  }
});
