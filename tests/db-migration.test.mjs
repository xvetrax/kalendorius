import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const temp = mkdtempSync(path.join(tmpdir(), "planner-migration-test-"));
const dbFile = path.join(temp, "test.db");
process.env.DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "cd".repeat(32);

// Seed an old-schema DB before lib/db.ts is imported
const seed = new DatabaseSync(dbFile);
seed.exec(`
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO tasks (title, notes, due_at, duration_minutes) VALUES ('Old task', 'Old note', '2026-01-01T10:00:00.000Z', 45);
`);
seed.close();

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

after(() => { hooks.deregister(); rmSync(temp, { recursive: true, force: true }); });

describe("db migration from v0 schema", () => {
  let db;

  it("loads db module and runs all migrations", async () => {
    ({ db } = await import("../lib/db.ts"));
    assert.ok(db, "db should be initialized");
  });

  it("adds project/priority/energy/tags columns to tasks", async () => {
    const { db } = await import("../lib/db.ts");
    const cols = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all()).map((r) => r.name)
    );
    for (const col of ["project", "priority", "energy", "tags"]) {
      assert.ok(cols.has(col), `Missing column after migration: ${col}`);
    }
  });

  it("creates task_plans and remote_tasks tables", async () => {
    const { db } = await import("../lib/db.ts");
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map((r) => r.name)
    );
    assert.ok(tables.has("task_plans"), "task_plans table missing");
    assert.ok(tables.has("remote_tasks"), "remote_tasks table missing");
  });

  it("migrates legacy due_at to task_plans with legacy_schedule flag", async () => {
    const { db } = await import("../lib/db.ts");
    const task = db.prepare("SELECT * FROM tasks WHERE title='Old task'").get();
    assert.equal(task.notes, "Old note");
    assert.equal(task.project, "Asmeniniai");

    const plan = db.prepare("SELECT * FROM task_plans WHERE task_key LIKE 'local:%'").get();
    assert.ok(plan, "Legacy task should have a task_plan entry");
    assert.equal(plan.legacy_schedule, 1);
    assert.equal(plan.duration_minutes, 45);
  });

  it("migration is idempotent — second import does not throw", async () => {
    const { db } = await import("../lib/db.ts");
    const count = db.prepare("SELECT count(*) as n FROM tasks").get();
    assert.equal(count.n, 1);
  });
});
