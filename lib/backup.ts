import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";

const APP_TABLES = ["tasks", "settings", "task_plans", "remote_tasks", "remote_task_lists"] as const;
const REQUIRED_TABLES = new Set(["tasks", "settings"]);
const SENSITIVE_KEYS = ["google_refresh_token", "microsoft_refresh_token"];
const REQUIRED_COLUMNS: Record<typeof APP_TABLES[number], readonly string[]> = {
  tasks: ["id", "title", "notes", "due_at", "duration_minutes", "completed", "created_at"],
  settings: ["key", "value"],
  task_plans: ["task_key", "scheduled_at", "duration_minutes", "schedule_version", "legacy_schedule", "mirror_requested", "mirror_event_id", "mirror_account_id", "mirror_transaction_id", "mirror_error", "project", "tags", "energy"],
  remote_tasks: ["task_key", "account_id", "list_id", "task_json"],
  remote_task_lists: ["list_key", "source", "account_id", "list_json"],
};
const PRIMARY_KEYS: Record<typeof APP_TABLES[number], string> = {
  tasks: "id",
  settings: "key",
  task_plans: "task_key",
  remote_tasks: "task_key",
  remote_task_lists: "list_key",
};

export class BackupError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function makeTempPath(prefix: string): string {
  const filename = `${prefix}-${process.hrtime.bigint()}.db`;
  const result = path.join(os.tmpdir(), filename);
  fs.closeSync(fs.openSync(result, "wx", 0o600));
  return result;
}

function quotedPath(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function copyDbTo(destination: string, excludeSettings: string[] = []) {
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type='table' AND name IN (${APP_TABLES.map(() => "?").join(",")})`
  ).all(...APP_TABLES) as { name: string; sql: string }[];
  if (tables.length !== APP_TABLES.length) throw new BackupError("Duomenų bazės schema nepilna; kopija nesukurta.");

  db.exec(`ATTACH DATABASE ${quotedPath(destination)} AS backup_target`);
  try {
    db.exec("BEGIN");
    try {
      for (const { name, sql } of tables) {
        db.exec(sql.replace(/^CREATE TABLE\s+/i, "CREATE TABLE backup_target."));
        if (name === "settings" && excludeSettings.length) {
          const placeholders = excludeSettings.map(() => "?").join(",");
          const rows = db.prepare(`SELECT * FROM main.settings WHERE key NOT IN (${placeholders})`).all(...excludeSettings) as Record<string, unknown>[];
          if (rows.length) {
            const columns = Object.keys(rows[0]);
            const insert = db.prepare(`INSERT INTO backup_target.settings (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
            for (const row of rows) insert.run(...columns.map(column => row[column]) as import("node:sqlite").SQLInputValue[]);
          }
        } else {
          db.exec(`INSERT INTO backup_target.${name} SELECT * FROM main.${name}`);
        }
      }
      const indexes = db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
           AND tbl_name IN (${APP_TABLES.map(() => "?").join(",")})`
      ).all(...APP_TABLES) as { sql: string }[];
      for (const { sql } of indexes) {
        db.exec(sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, match => match.replace("INDEX ", "INDEX backup_target.")));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("DETACH DATABASE backup_target");
  }
}

function createCopy(excludeSettings: string[] = []) {
  const temporary = makeTempPath("planner-copy");
  try {
    copyDbTo(temporary, excludeSettings);
    return fs.readFileSync(temporary);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function createBackup(): Buffer {
  return createCopy();
}

export function createExport(): Buffer {
  return createCopy(SENSITIVE_KEYS);
}

type ColumnInfo = { name: string; type: string; pk: number };

function tableInfo(database: DatabaseSync, schema: "main" | "restore_source", table: string) {
  return database.prepare(`PRAGMA ${schema}.table_info("${table.replaceAll('"', '""')}")`).all() as ColumnInfo[];
}

function validateBackup(database: DatabaseSync) {
  const integrity = database.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new BackupError("Atsarginė kopija pažeista.");
  const objects = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string; sql: string | null }[];
  const tables = objects.filter(item => item.type === "table");
  if (objects.some(item => item.type !== "table" && item.type !== "index")) throw new BackupError("Atsarginėje kopijoje yra nepalaikomų objektų.");
  if (tables.some(item => !APP_TABLES.includes(item.name as typeof APP_TABLES[number]) || !item.sql?.startsWith("CREATE TABLE"))) {
    throw new BackupError("Atsarginėje kopijoje yra neatpažintų lentelių.");
  }
  for (const required of REQUIRED_TABLES) if (!tables.some(table => table.name === required)) throw new BackupError(`Atsarginėje kopijoje trūksta ${required} lentelės.`);
  for (const table of tables) {
    const name = table.name as typeof APP_TABLES[number];
    const incoming = tableInfo(database, "main", name);
    const current = tableInfo(db, "main", name);
    const currentByName = new Map(current.map(column => [column.name, column]));
    if (incoming.some(column => !currentByName.has(column.name) || currentByName.get(column.name)?.type.toUpperCase() !== column.type.toUpperCase())) {
      throw new BackupError(`Atsarginės kopijos ${name} schema yra naujesnė arba nepalaikoma.`);
    }
    if (REQUIRED_COLUMNS[name].some(column => !incoming.some(candidate => candidate.name === column))) {
      throw new BackupError(`Atsarginės kopijos ${name} schemoje trūksta būtinų stulpelių.`);
    }
    if (!incoming.some(column => column.name === PRIMARY_KEYS[name] && column.pk > 0)) {
      throw new BackupError(`Atsarginės kopijos ${name} tapatybės schema nepalaikoma.`);
    }
  }
  return tables.map(table => table.name);
}

export function restoreBackup(data: Buffer): { tablesRestored: number } {
  if (data.length < 16 || !data.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) {
    throw new BackupError("Netinkamas failo formatas — reikalinga SQLite atsarginė kopija.");
  }
  const temporary = makeTempPath("planner-restore");
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    const incoming = new DatabaseSync(temporary, { readOnly: true });
    let incomingTables: string[];
    try { incomingTables = validateBackup(incoming); }
    finally { incoming.close(); }

    db.exec(`ATTACH DATABASE ${quotedPath(temporary)} AS restore_source`);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of [...APP_TABLES].reverse()) db.exec(`DELETE FROM main.${table}`);
        for (const table of APP_TABLES) {
          if (!incomingTables.includes(table)) continue;
          const sourceColumns = tableInfo(db, "restore_source", table).map(column => column.name);
          const destinationColumns = tableInfo(db, "main", table).map(column => column.name);
          const columns = sourceColumns.filter(column => destinationColumns.includes(column));
          if (!columns.length) throw new BackupError(`Atsarginės kopijos ${table} lentelė tuščia arba nesuderinama.`);
          const list = columns.map(column => `"${column.replaceAll('"', '""')}"`).join(",");
          db.exec(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM restore_source.${table}`);
        }
        if (!db.prepare("SELECT 1 FROM main.settings WHERE key = 'migration_task_plans_v1'").get()) {
          const legacyTasks = db.prepare("SELECT id, due_at, duration_minutes FROM main.tasks WHERE due_at IS NOT NULL").all() as { id: number; due_at: string; duration_minutes: number }[];
          const insertPlan = db.prepare("INSERT OR IGNORE INTO main.task_plans (task_key, scheduled_at, duration_minutes, legacy_schedule) VALUES (?, ?, ?, 1)");
          for (const task of legacyTasks) {
            if (Number.isFinite(Date.parse(task.due_at))) insertPlan.run(`local:${task.id}`, task.due_at, Math.min(1440, Math.max(5, task.duration_minutes || 30)));
          }
          db.prepare("INSERT INTO main.settings (key, value) VALUES ('migration_task_plans_v1', '1')").run();
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.exec("DETACH DATABASE restore_source");
    }
    return { tablesRestored: incomingTables.length };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("Atsarginės kopijos atkurti nepavyko; esami duomenys nepakeisti.");
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
