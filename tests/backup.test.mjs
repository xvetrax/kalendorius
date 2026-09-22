import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const temp = mkdtempSync(path.join(tmpdir(), "planner-backup-test-"));
const dbFile = path.join(temp, "backup-test.db");
process.env.DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);
process.env.APP_ORIGIN = "http://localhost:3000";
delete process.env.APP_PASSWORD;

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
  let db, createBackup, createExport, restoreBackup, BackupError, POST, PUT, readBodyWithinLimit;

  before(async () => {
    ({ db } = await import("../lib/db.ts"));
    ({ BackupError, createBackup, createExport, restoreBackup } = await import("../lib/backup.ts"));
    ({ POST, PUT, readBodyWithinLimit } = await import("../app/api/backup/route.ts"));
  });

  beforeEach(() => {
    db.exec(`
      DELETE FROM remote_task_lists;
      DELETE FROM remote_tasks;
      DELETE FROM task_plans;
      DELETE FROM settings;
      DELETE FROM tasks;
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("migration_task_plans_v1", "1");
  });

  function seedAllTables() {
    const task = db.prepare("INSERT INTO tasks (title, notes, due_at, duration_minutes, project, priority, energy, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("Backup task", "Notes", "2026-10-01T09:00:00.000Z", 45, "Darbas", "high", "high", "audit");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("google_refresh_token", "SECRET_TOKEN");
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("color_theme", "dark");
    db.prepare("INSERT INTO task_plans (task_key, scheduled_at, duration_minutes, project, tags, energy) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`local:${task.lastInsertRowid}`, "2026-10-01T08:00:00.000Z", 45, "Darbas", "audit", "high");
    db.prepare("INSERT INTO remote_tasks (task_key, account_id, list_id, task_json, source) VALUES (?, ?, ?, ?, ?)")
      .run("google:acct:list:task", "acct", "list", JSON.stringify({ title: "Remote task" }), "google");
    db.prepare("INSERT INTO remote_task_lists (list_key, source, account_id, list_json) VALUES (?, ?, ?, ?)")
      .run("google:acct:list", "google", "acct", JSON.stringify({ name: "Inbox" }));
    return Number(task.lastInsertRowid);
  }

  it("creates a complete SQLite backup and restores every app table transactionally", () => {
    const originalId = seedAllTables();
    const backup = createBackup();
    assert.ok(backup.toString("utf8", 0, 16).startsWith("SQLite format 3"));

    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Changed later", originalId);
    db.prepare("DELETE FROM settings WHERE key = ?").run("google_refresh_token");
    db.prepare("DELETE FROM task_plans").run();
    db.prepare("DELETE FROM remote_tasks").run();
    db.prepare("DELETE FROM remote_task_lists").run();
    db.prepare("INSERT INTO tasks (title) VALUES (?)").run("Created later");

    assert.deepEqual(restoreBackup(backup), { tablesRestored: 5 });
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id = ?").get(originalId)?.title, "Backup task");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("google_refresh_token")?.value, "SECRET_TOKEN");
    assert.equal(db.prepare("SELECT scheduled_at FROM task_plans").get()?.scheduled_at, "2026-10-01T08:00:00.000Z");
    assert.equal(db.prepare("SELECT source FROM remote_tasks").get()?.source, "google");
    assert.equal(db.prepare("SELECT source FROM remote_task_lists").get()?.source, "google");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

    const inserted = db.prepare("INSERT INTO tasks (title) VALUES (?)").run("After restore");
    assert.ok(Number(inserted.lastInsertRowid) > originalId, "database must remain writable with a valid sequence");
  });

  it("exports all app data without OAuth refresh tokens", () => {
    seedAllTables();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("microsoft_refresh_token", "MICROSOFT_SECRET");
    const exportFile = path.join(temp, "check-export.db");
    writeFileSync(exportFile, createExport(), { mode: 0o600 });
    const exported = new DatabaseSync(exportFile, { readOnly: true });
    try {
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM task_plans").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM remote_tasks").get().count, 1);
      assert.equal(exported.prepare("SELECT COUNT(*) AS count FROM remote_task_lists").get().count, 1);
      assert.equal(exported.prepare("SELECT value FROM settings WHERE key='google_refresh_token'").get(), undefined);
      assert.equal(exported.prepare("SELECT value FROM settings WHERE key='microsoft_refresh_token'").get(), undefined);
      assert.equal(exported.prepare("SELECT value FROM settings WHERE key='color_theme'").get()?.value, "dark");
    } finally {
      exported.close();
    }
  });

  it("restores an older tasks/settings backup using current defaults", () => {
    const oldPath = path.join(temp, "old-schema.db");
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

    assert.deepEqual(restoreBackup(readFileSync(oldPath)), { tablesRestored: 2 });
    const task = db.prepare("SELECT title, project, priority, energy, tags FROM tasks").get();
    assert.equal(JSON.stringify(task), JSON.stringify({ title: "Sena užduotis", project: "Asmeniniai", priority: "normal", energy: "medium", tags: "" }));
    assert.equal(JSON.stringify(db.prepare("SELECT task_key, scheduled_at, duration_minutes, legacy_schedule FROM task_plans").get()), JSON.stringify({
      task_key: "local:1", scheduled_at: "2026-09-30T10:00:00.000Z", duration_minutes: 55, legacy_schedule: 1,
    }));
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='migration_task_plans_v1'").get()?.value, "1");
  });

  it("rejects invalid, unknown, and newer schemas without changing live data", () => {
    db.prepare("INSERT INTO tasks (title) VALUES (?)").run("Keep me");
    assert.throws(() => restoreBackup(Buffer.from("definitely not sqlite")), BackupError);

    const badPath = path.join(temp, "unknown-table.db");
    const bad = new DatabaseSync(badPath);
    bad.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE unknown_alien_table (x TEXT)");
    bad.close();
    assert.throws(() => restoreBackup(readFileSync(badPath)), /neatpažintų lentelių/i);

    const newerPath = path.join(temp, "newer-schema.db");
    const newer = new DatabaseSync(newerPath);
    newer.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, future_column TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    newer.close();
    assert.throws(() => restoreBackup(readFileSync(newerPath)), /naujesnė arba nepalaikoma/i);

    const constraintPath = path.join(temp, "constraint-error.db");
    const constraint = new DatabaseSync(constraintPath);
    constraint.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, notes TEXT, due_at TEXT, duration_minutes INTEGER, completed INTEGER, created_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO tasks (id, title, notes, duration_minutes, completed, created_at) VALUES (1, NULL, '', 30, 0, CURRENT_TIMESTAMP);
    `);
    constraint.close();
    assert.throws(() => restoreBackup(readFileSync(constraintPath)), /esami duomenys nepakeisti/i);

    const missingIdentityPath = path.join(temp, "missing-identity.db");
    const missingIdentity = new DatabaseSync(missingIdentityPath);
    missingIdentity.exec(`
      CREATE TABLE tasks (title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE task_plans (task_key TEXT PRIMARY KEY, scheduled_at TEXT, duration_minutes INTEGER NOT NULL DEFAULT 30, schedule_version INTEGER NOT NULL DEFAULT 0, legacy_schedule INTEGER NOT NULL DEFAULT 0, mirror_requested INTEGER NOT NULL DEFAULT 0, mirror_event_id TEXT, mirror_account_id TEXT, mirror_transaction_id TEXT, mirror_error TEXT, project TEXT, tags TEXT, energy TEXT);
      INSERT INTO tasks (title) VALUES ('Identity-less');
      INSERT INTO task_plans (task_key) VALUES ('local:99');
    `);
    missingIdentity.close();
    assert.throws(() => restoreBackup(readFileSync(missingIdentityPath)), /trūksta būtinų stulpelių/i);
    assert.equal(JSON.stringify(db.prepare("SELECT title FROM tasks").all()), JSON.stringify([{ title: "Keep me" }]));
  });

  it("limits a streamed upload before buffering the complete body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const request = new Request("http://localhost:3000/api/backup", { method: "PUT", body: stream, duplex: "half" });
    await assert.rejects(() => readBodyWithinLimit(request, 5), error => error instanceof BackupError && error.status === 413);
  });

  it("uses POST for downloads, PUT for restore, and enforces session/origin checks", async () => {
    seedAllTables();
    const noOrigin = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "full" }),
    }));
    assert.equal(noOrigin.status, 403);

    const invalid = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ type: "other" }),
    }));
    assert.equal(invalid.status, 400);
    const invalidShape = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "null",
    }));
    assert.equal(invalidShape.status, 400);

    const download = await POST(new Request("http://localhost:3000/api/backup", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ type: "full" }),
    }));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /planner-backup-/);
    const downloaded = Buffer.from(await download.arrayBuffer());

    db.prepare("UPDATE tasks SET title = ?").run("Changed through API");
    const restored = await PUT(new Request("http://localhost:3000/api/backup", {
      method: "PUT", headers: { origin: "http://localhost:3000", "content-type": "application/octet-stream" }, body: downloaded,
    }));
    assert.equal(restored.status, 200);
    assert.equal(db.prepare("SELECT title FROM tasks").get()?.title, "Backup task");

    process.env.APP_PASSWORD = "required";
    try {
      const unauthenticated = await POST(new Request("http://localhost:3000/api/backup", {
        method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ type: "export" }),
      }));
      assert.equal(unauthenticated.status, 401);
    } finally {
      delete process.env.APP_PASSWORD;
    }
  });
});
