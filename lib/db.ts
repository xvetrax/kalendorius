import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migrateTaskPlanning } from "@/lib/task-service";

const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const dbPath = isBuild ? ":memory:" : (process.env.DATABASE_PATH || path.join(process.cwd(), "data", "planner.db"));
if (!isBuild) fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const globalDb = globalThis as typeof globalThis & { plannerDb?: DatabaseSync };
export const db = globalDb.plannerDb ?? new DatabaseSync(dbPath);
if (process.env.NODE_ENV !== "production") globalDb.plannerDb = db;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(completed) WHERE completed = 0;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const taskColumns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((column) => column.name));
const migrations = [
  ["project", "ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT 'Asmeniniai'"],
  ["priority", "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'"],
  ["energy", "ALTER TABLE tasks ADD COLUMN energy TEXT NOT NULL DEFAULT 'medium'"],
  ["tags", "ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''"],
] as const;
for (const [column, sql] of migrations) {
  if (!taskColumns.has(column)) db.exec(sql);
}
migrateTaskPlanning(db);

export function setting(key: string) {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
}

export function saveSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export function deleteSettings(...keys: string[]) {
  const statement = db.prepare("DELETE FROM settings WHERE key = ?");
  db.exec("BEGIN");
  try {
    for (const key of keys) statement.run(key);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
