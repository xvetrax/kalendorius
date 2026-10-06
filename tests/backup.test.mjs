import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const temp = mkdtempSync(path.join(tmpdir(), "planner-backup-test-"));
const dbFile = path.join(temp, "backup-test.db");
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.APP_ORIGIN = "http://localhost:3000";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier.startsWith("@/")
        ? pathToFileURL(path.resolve(import.meta.dirname, "..", specifier.slice(2) + ".ts")).href
        : specifier,
      context
    );
  },
});

after(() => {
  hooks.deregister();
  rmSync(temp, { recursive: true, force: true });
});

describe("backup", { concurrency: false }, () => {
  let db, createBackup, createUserExport, restoreBackup, BackupError, GET, POST, PUT, readBodyWithinLimit;
  let testUserId;

  before(async () => {
    ({ db } = await import("../lib/db-multi.ts"));
    ({ BackupError, createBackup, createUserExport, restoreBackup } = await import("../lib/backup.ts"));
    ({ GET, POST, PUT, readBodyWithinLimit } = await import("../app/api/backup/route.ts"));
  });

  beforeEach(() => {
    // Clear all user-data and auth tables in safe order (children first)
    db.exec(`
      DELETE FROM notification_deliveries;
      DELETE FROM notification_jobs;
      DELETE FROM notification_preferences;
      DELETE FROM calendar_event_creates;
      DELETE FROM remote_task_lists;
      DELETE FROM remote_tasks;
      DELETE FROM task_plans;
      DELETE FROM tasks;
      DELETE FROM calendar_preferences;
      DELETE FROM calendar_preference_sets;
      DELETE FROM user_settings;
      DELETE FROM push_subscriptions;
      DELETE FROM push_rate_limits;
      DELETE FROM security_events;
      DELETE FROM oauth_connections;
      DELETE FROM auth_operations;
      DELETE FROM sessions;
      DELETE FROM auth_identities;
      DELETE FROM users;
      DELETE FROM settings;
    `);

    // Seed a test admin user
    const result = db.prepare(
      "INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'admin', 'active')"
    ).run("Test Admin", "admin@example.com");
    testUserId = Number(result.lastInsertRowid);
  });

  function seedUserTables() {
    const task = db.prepare(
      "INSERT INTO tasks (user_id, title, notes, due_at, duration_minutes, project, priority, energy, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(testUserId, "Backup task", "Notes", "2026-10-01T09:00:00.000Z", 45, "Darbas", "high", "high", "audit");
    const taskId = Number(task.lastInsertRowid);

    db.prepare(
      "INSERT INTO task_plans (user_id, task_key, scheduled_at, duration_minutes, project, tags, energy, mirror_orphaned_at, mirror_orphan_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(testUserId, `local:${taskId}`, "2026-10-01T08:00:00.000Z", 45, "Darbas", "audit", "high", "2026-09-23 10:00:00", "Likęs blokas");

    db.prepare(
      "INSERT INTO remote_tasks (user_id, task_key, account_id, list_id, task_json, source) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(testUserId, "google:acct:list:task", "acct", "list", JSON.stringify({ title: "Remote task" }), "google");

    db.prepare(
      "INSERT INTO remote_task_lists (user_id, list_key, source, account_id, list_json) VALUES (?, ?, ?, ?, ?)"
    ).run(testUserId, "google:acct:list", "google", "acct", JSON.stringify({ name: "Inbox" }));

    db.prepare(
      "INSERT INTO calendar_event_creates (user_id, provider, account_id, connection_id, calendar_id, operation_id, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(testUserId, "google", "acct", "connection", "primary", "00000000-0000-4000-8000-000000000001", "fingerprint");

    // Add an oauth_connection with encrypted_refresh_token (should never appear in user export)
    db.prepare(
      "INSERT INTO oauth_connections (user_id, provider, provider_account_id, encrypted_refresh_token, scopes, generation, status) VALUES (?, ?, ?, ?, ?, 1, 'active')"
    ).run(testUserId, "google", "google-sub-123", "ENCRYPTED_TOKEN_SECRET", "calendar.readonly");
    const connectionId = db.prepare(
      "SELECT id FROM oauth_connections WHERE user_id = ? AND provider = 'google' AND provider_account_id = 'google-sub-123'"
    ).get(testUserId).id;
    db.prepare(
      "INSERT INTO calendar_preference_sets (user_id, connection_id, explicit) VALUES (?, ?, 1)"
    ).run(testUserId, connectionId);
    db.prepare(
      "INSERT INTO calendar_preferences (user_id, connection_id, calendar_id, enabled) VALUES (?, ?, 'primary', 1)"
    ).run(testUserId, connectionId);
    db.prepare(
      "INSERT INTO push_subscriptions (user_id, endpoint_hash, encrypted_subscription, device_name) VALUES (?, ?, ?, ?)"
    ).run(testUserId, "a".repeat(64), "iv.tag.encrypted-push-capability", "Test Chrome");
    db.prepare(
      "INSERT INTO notification_preferences (user_id, scenario, enabled) VALUES (?, 'focus_end', 1)"
    ).run(testUserId);
    db.prepare(
      "INSERT INTO notification_jobs (user_id, scenario, source_key, run_at, expires_at) VALUES (?, 'focus_end', 'backup-job', ?, ?)"
    ).run(testUserId, "2026-10-01T09:00:00.000Z", "2026-10-01T09:15:00.000Z");

    return taskId;
  }

  function insertSession(userId) {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at) VALUES (?, ?, ?, ?)"
    ).run(tokenHash, userId, expiresAt, new Date().toISOString());
    return `planner_session=${rawToken}`;
  }

  it("creates a complete SQLite backup and restores every app table transactionally", () => {
    const originalId = seedUserTables();
    db.prepare("UPDATE task_plans SET scheduled_at = '2099-12-01T08:00:00.000Z' WHERE user_id = ?").run(testUserId);
    db.prepare("INSERT INTO notification_preferences (user_id, scenario, enabled, lead_minutes) VALUES (?, 'task_start', 1, 10)").run(testUserId);
    const backup = createBackup();
    assert.ok(backup.toString("utf8", 0, 16).startsWith("SQLite format 3"));

    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Changed later", originalId);
    db.prepare("DELETE FROM task_plans").run();
    db.prepare("DELETE FROM remote_tasks").run();
    db.prepare("DELETE FROM remote_task_lists").run();
    db.prepare("DELETE FROM calendar_event_creates").run();
    db.prepare("INSERT INTO tasks (user_id, title) VALUES (?, ?)").run(testUserId, "Created later");

    const result = restoreBackup(backup);
    assert.ok(result.tablesRestored >= 2, "must restore at least users and tasks");
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id = ?").get(originalId)?.title, "Backup task");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    assert.equal(db.prepare("SELECT scheduled_at FROM task_plans").get()?.scheduled_at, "2099-12-01T08:00:00.000Z");
    assert.equal(db.prepare("SELECT mirror_orphan_title FROM task_plans").get()?.mirror_orphan_title, "Likęs blokas");
    assert.equal(db.prepare("SELECT source FROM remote_tasks").get()?.source, "google");
    assert.equal(db.prepare("SELECT source FROM remote_task_lists").get()?.source, "google");
    assert.equal(db.prepare("SELECT fingerprint FROM calendar_event_creates").get()?.fingerprint, "fingerprint");
    assert.equal(db.prepare("SELECT explicit FROM calendar_preference_sets").get()?.explicit, 1);
    assert.equal(db.prepare("SELECT calendar_id FROM calendar_preferences").get()?.calendar_id, "primary");
    assert.equal(db.prepare("SELECT color_key FROM oauth_connections").get()?.color_key, "google:google-sub-123");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get().count, 0, "restore must invalidate push capabilities");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_rate_limits").get().count, 0, "restore must clear stale push throttles");
    assert.equal(db.prepare("SELECT enabled FROM notification_preferences WHERE user_id = ? AND scenario = 'focus_end'").get(testUserId).enabled, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE scenario = 'focus_end'").get().count, 0, "restore must clear old operational notification jobs");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE scenario = 'task_start' AND cancelled_at IS NULL").get().count, 1, "restore must rebuild task-start jobs from restored plans");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

    // DB must remain writable after restore
    const inserted = db.prepare("INSERT INTO tasks (user_id, title) VALUES (?, ?)").run(testUserId, "After restore");
    assert.ok(Number(inserted.lastInsertRowid) > originalId, "database must remain writable with a valid sequence");
  });

  it("full backup includes oauth_connections with encrypted token", () => {
    seedUserTables();
    const exportFile = path.join(temp, "check-full-backup.db");
    writeFileSync(exportFile, createBackup(), { mode: 0o600 });
    const backed = new DatabaseSync(exportFile, { readOnly: true });
    try {
      // Full backup includes oauth_connections
      assert.equal(backed.prepare("SELECT COUNT(*) AS count FROM oauth_connections").get().count, 1);
      // And the encrypted token is present in full backup (admin access)
      assert.ok(backed.prepare("SELECT encrypted_refresh_token FROM oauth_connections").get()?.encrypted_refresh_token);
      assert.equal(backed.prepare("SELECT COUNT(*) AS count FROM calendar_preferences").get().count, 1);
      assert.equal(backed.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get().count, 1);
      assert.equal(backed.prepare("SELECT encrypted_subscription FROM push_subscriptions").get().encrypted_subscription, "iv.tag.encrypted-push-capability");
      assert.equal(backed.prepare("SELECT enabled FROM notification_preferences").get().enabled, 1);
      assert.equal(backed.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notification_jobs'").get().count, 0);
      assert.equal(backed.prepare("PRAGMA user_version").get().user_version, 5);
    } finally {
      backed.close();
    }
  });

  it("user export contains only own work data without any secret columns", () => {
    seedUserTables();
    const exportFile = path.join(temp, "check-user-export.db");
    writeFileSync(exportFile, createUserExport(testUserId), { mode: 0o600 });
    const exported = new DatabaseSync(exportFile, { readOnly: true });
    try {
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM task_plans").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM remote_tasks").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM remote_task_lists").get().count, 1);

      // Authentication and integration-secret tables must NOT exist in user export
      const tables = exported.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all().map(r => r.name);
      assert.ok(!tables.includes("oauth_connections"), "oauth_connections must not be in user export");
      assert.ok(!tables.includes("sessions"), "sessions must not be in user export");
      assert.ok(!tables.includes("auth_operations"), "auth_operations must not be in user export");
      assert.ok(!tables.includes("security_events"), "security_events must not be in user export");
      assert.ok(!tables.includes("users"), "users must not be in user export");
      assert.ok(!tables.includes("push_subscriptions"), "push_subscriptions must not be in user export");
      assert.ok(!tables.includes("push_rate_limits"), "push_rate_limits must not be in user export");
    } finally {
      exported.close();
    }
  });

  it("user export contains only rows belonging to the requesting user", () => {
    seedUserTables();

    // Seed a second user with their own tasks
    const otherResult = db.prepare(
      "INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'member', 'active')"
    ).run("Other User", "other@example.com");
    const otherUserId = Number(otherResult.lastInsertRowid);
    db.prepare(
      "INSERT INTO tasks (user_id, title) VALUES (?, ?)"
    ).run(otherUserId, "Other user task");

    const exportFile = path.join(temp, "isolation-export.db");
    writeFileSync(exportFile, createUserExport(testUserId), { mode: 0o600 });
    const exported = new DatabaseSync(exportFile, { readOnly: true });
    try {
      // Only testUserId's task should appear
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
      assert.equal(exported.prepare("SELECT title FROM tasks").get()?.title, "Backup task");
    } finally {
      exported.close();
    }
  });

  it("rejects old single-user backup (settings but no users table) with clear message", () => {
    const oldPath = path.join(temp, "old-single-user.db");
    const old = new DatabaseSync(oldPath);
    old.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        due_at TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO tasks (title, due_at, duration_minutes) VALUES ('Sena užduotis', '2026-09-30T10:00:00.000Z', 55);
      INSERT INTO settings (key, value) VALUES ('color_theme', 'light');
    `);
    old.close();

    assert.throws(
      () => restoreBackup(readFileSync(oldPath)),
      (err) => err instanceof BackupError && /sena vieno naudotojo schema/i.test(err.message)
    );
  });

  it("rejects invalid, unknown, and newer schemas without changing live data", () => {
    db.prepare("INSERT INTO tasks (user_id, title) VALUES (?, ?)").run(testUserId, "Keep me");
    assert.throws(() => restoreBackup(Buffer.from("definitely not sqlite")), BackupError);

    const badPath = path.join(temp, "unknown-table.db");
    const bad = new DatabaseSync(badPath);
    // Has users (required) but also an alien table
    bad.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, primary_email TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE unknown_alien_table (x TEXT)
    `);
    bad.close();
    assert.throws(() => restoreBackup(readFileSync(badPath)), /neatpažintų lentelių/i);

    const newerPath = path.join(temp, "newer-schema.db");
    const newer = new DatabaseSync(newerPath);
    newer.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, primary_email TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, future_column TEXT)
    `);
    newer.close();
    assert.throws(() => restoreBackup(readFileSync(newerPath)), /naujesnė arba nepalaikoma/i);

    // Live data must be unchanged
    assert.equal(JSON.stringify(db.prepare("SELECT title FROM tasks").all()), JSON.stringify([{ title: "Keep me" }]));
  });

  it("schema v5 backup must include notification preferences", () => {
    seedUserTables();
    const incompletePath = path.join(temp, "missing-notification-preferences.db");
    writeFileSync(incompletePath, createBackup(), { mode: 0o600 });
    const incomplete = new DatabaseSync(incompletePath);
    incomplete.exec("DROP TABLE notification_preferences");
    incomplete.close();
    assert.throws(
      () => restoreBackup(readFileSync(incompletePath)),
      (error) => error instanceof BackupError && /pranešimų nuostatų lentelės/i.test(error.message),
    );
  });

  it("limits a streamed upload before buffering the complete body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const request = new Request("http://localhost:3000/api/backup", { method: "POST", body: stream, duplex: "half" });
    await assert.rejects(() => readBodyWithinLimit(request, 5), error => error instanceof BackupError && error.status === 413);
  });

  it("supports legacy and browser backup contracts while enforcing session/origin checks", async () => {
    seedUserTables();

    // GET without session → 401
    const noSession = await GET(new Request("http://localhost:3000/api/backup", {
      method: "GET", headers: { origin: "http://localhost:3000" },
    }));
    assert.equal(noSession.status, 401);

    // Create a real session for the admin user
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at) VALUES (?, ?, ?, ?)"
    ).run(tokenHash, testUserId, expiresAt, new Date().toISOString());
    const sessionCookie = `planner_session=${rawToken}`;

    // GET without origin → 403 (CSRF)
    const noOrigin = await GET(new Request("http://localhost:3000/api/backup", {
      method: "GET", headers: { cookie: sessionCookie },
    }));
    assert.equal(noOrigin.status, 403);

    // GET full backup as admin → 200
    const download = await GET(new Request("http://localhost:3000/api/backup", {
      method: "GET", headers: { origin: "http://localhost:3000", cookie: sessionCookie },
    }));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /planner-backup-/);
    const downloaded = Buffer.from(await download.arrayBuffer());

    // Browser contract: POST JSON creates the same full backup while retaining
    // an Origin-bearing request that cannot be triggered by a plain link.
    const browserDownload = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "full" }),
    }));
    assert.equal(browserDownload.status, 200);
    assert.match(browserDownload.headers.get("content-disposition") ?? "", /planner-backup-/);

    // GET ?type=export as admin → 200
    const exportDownload = await GET(new Request("http://localhost:3000/api/backup?type=export", {
      method: "GET", headers: { origin: "http://localhost:3000", cookie: sessionCookie },
    }));
    assert.equal(exportDownload.status, 200);
    assert.match(exportDownload.headers.get("content-disposition") ?? "", /planner-export-/);

    // POST restore without session → 401
    const noSessionRestore = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/octet-stream" }, body: downloaded,
    }));
    assert.equal(noSessionRestore.status, 401);

    // POST restore as admin → 200
    db.prepare("UPDATE tasks SET title = ?").run("Changed through API");
    const restored = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", cookie: sessionCookie, "content-type": "application/octet-stream" }, body: downloaded,
    }));
    assert.equal(restored.status, 200);
    assert.equal(db.prepare("SELECT title FROM tasks").get()?.title, "Backup task");

    // Browser contract restores with PUT so POST JSON remains unambiguous.
    const browserToken = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at) VALUES (?, ?, ?, ?)"
    ).run(createHash("sha256").update(browserToken).digest("hex"), testUserId, expiresAt, new Date().toISOString());
    const browserCookie = `planner_session=${browserToken}`;
    db.prepare("UPDATE tasks SET title = ?").run("Changed before browser restore");
    const browserRestored = await PUT(new Request("http://localhost:3000/api/backup", {
      method: "PUT", headers: { origin: "http://localhost:3000", cookie: browserCookie, "content-type": "application/octet-stream" }, body: downloaded,
    }));
    assert.equal(browserRestored.status, 200);
    assert.equal(db.prepare("SELECT title FROM tasks").get()?.title, "Backup task");

    // GET full backup as non-admin → 403
    const memberResult = db.prepare(
      "INSERT INTO users (display_name, primary_email, role, status) VALUES (?, ?, 'member', 'active')"
    ).run("Member", "member@example.com");
    const memberId = Number(memberResult.lastInsertRowid);
    const memberToken = randomBytes(32).toString("hex");
    const memberHash = createHash("sha256").update(memberToken).digest("hex");
    db.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at) VALUES (?, ?, ?, ?)"
    ).run(memberHash, memberId, expiresAt, new Date().toISOString());
    const memberCookie = `planner_session=${memberToken}`;

    const memberBackup = await GET(new Request("http://localhost:3000/api/backup", {
      method: "GET", headers: { origin: "http://localhost:3000", cookie: memberCookie },
    }));
    assert.equal(memberBackup.status, 403);

    // GET ?type=export as member → 200 (any authenticated user can export their data)
    const memberExport = await GET(new Request("http://localhost:3000/api/backup?type=export", {
      method: "GET", headers: { origin: "http://localhost:3000", cookie: memberCookie },
    }));
    assert.equal(memberExport.status, 200);
    assert.match(memberExport.headers.get("content-disposition") ?? "", /planner-export-/);

    // POST restore as non-admin → 403
    const memberRestore = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", cookie: memberCookie, "content-type": "application/octet-stream" }, body: downloaded,
    }));
    assert.equal(memberRestore.status, 403);
  });
});
