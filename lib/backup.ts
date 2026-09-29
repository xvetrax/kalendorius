import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DATABASE_SCHEMA_VERSION,
  db,
  normalizeMultiAccountData,
} from "@/lib/db-multi";

// ---------------------------------------------------------------------------
// Table registry
// ---------------------------------------------------------------------------

/**
 * ALL_TABLES — full set of multi-user schema tables that are included in an
 * admin full backup (createBackup).  Order matters for FK-safe restore: parents
 * before children on write, children before parents on delete.
 */
const ALL_TABLES = [
  "users",
  "auth_identities",
  "sessions",
  "auth_operations",
  "oauth_connections",
  "calendar_preferences",
  "calendar_preference_sets",
  "user_settings",
  "security_events",
  "tasks",
  "task_plans",
  "remote_tasks",
  "remote_task_lists",
  "calendar_event_creates",
  "settings",
] as const;

type AllTable = (typeof ALL_TABLES)[number];

/**
 * USER_DATA_TABLES — tables exported per-user (no secrets, no auth state).
 * These are the tables that contain a user_id FK and hold user work data.
 */
const USER_DATA_TABLES = [
  "tasks",
  "task_plans",
  "remote_tasks",
  "remote_task_lists",
] as const;

type UserDataTable = (typeof USER_DATA_TABLES)[number];

/**
 * REQUIRED_TABLES — every valid multi-user backup must contain these.
 */
const REQUIRED_TABLES = new Set<string>(["users", "tasks"]);

/**
 * SENSITIVE_KEYS — column names that must never appear in a user export.
 * Also used as settings keys to exclude from settings export.
 */
const SENSITIVE_KEYS = [
  // settings table (legacy OAuth secrets)
  "google_refresh_token",
  "microsoft_refresh_token",
  // oauth_connections column
  "encrypted_refresh_token",
  // sessions / auth_operations columns (token hashes)
  "token_hash",
  "state_hash",
  "pkce_verifier",
  "nonce",
];

/**
 * REQUIRED_COLUMNS — minimum columns that must be present for each table in a
 * backup to be considered structurally valid.
 */
const REQUIRED_COLUMNS: Record<AllTable, readonly string[]> = {
  users: ["id", "display_name", "primary_email", "role", "status", "created_at"],
  auth_identities: ["id", "user_id", "provider", "issuer", "subject"],
  sessions: ["id", "token_hash", "user_id", "expires_at"],
  auth_operations: ["id", "state_hash", "nonce", "pkce_verifier", "provider", "expires_at", "used"],
  oauth_connections: ["id", "user_id", "provider", "provider_account_id", "generation", "status"],
  calendar_preferences: ["user_id", "connection_id", "calendar_id", "enabled", "updated_at"],
  calendar_preference_sets: ["user_id", "connection_id", "explicit", "updated_at"],
  user_settings: ["user_id", "key", "value"],
  security_events: ["id", "event_type", "created_at"],
  tasks: ["id", "user_id", "title", "notes", "due_at", "duration_minutes", "completed", "created_at"],
  task_plans: [
    "task_key", "user_id", "scheduled_at", "duration_minutes", "schedule_version",
    "legacy_schedule", "mirror_requested", "mirror_event_id", "mirror_account_id",
    "mirror_transaction_id", "mirror_error", "project", "tags", "energy",
  ],
  remote_tasks: ["task_key", "user_id", "account_id", "list_id", "task_json"],
  remote_task_lists: ["list_key", "user_id", "source", "account_id", "list_json"],
  calendar_event_creates: [
    "user_id", "provider", "account_id", "connection_id", "calendar_id", "operation_id", "fingerprint", "created_at",
  ],
  settings: ["key", "value"],
};

const PRIMARY_KEYS: Record<AllTable, readonly string[]> = {
  users: ["id"],
  auth_identities: ["id"],
  sessions: ["id"],
  auth_operations: ["id"],
  oauth_connections: ["id"],
  calendar_preferences: ["user_id", "connection_id", "calendar_id"],
  calendar_preference_sets: ["user_id", "connection_id"],
  user_settings: ["user_id", "key"],
  security_events: ["id"],
  tasks: ["id"],
  task_plans: ["id"],
  remote_tasks: ["id"],
  remote_task_lists: ["id"],
  calendar_event_creates: ["id"],
  settings: ["key"],
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BackupError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeTempPath(prefix: string): string {
  const filename = `${prefix}-${process.hrtime.bigint()}.db`;
  const result = path.join(os.tmpdir(), filename);
  fs.closeSync(fs.openSync(result, "wx", 0o600));
  return result;
}

function quotedPath(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type ColumnInfo = { name: string; type: string; pk: number };

function tableInfo(database: DatabaseSync, schema: string, table: string) {
  return database.prepare(`PRAGMA ${schema}.table_info("${table.replaceAll('"', '""')}")`).all() as ColumnInfo[];
}

/**
 * stripForeignKeys — removes REFERENCES clauses from a CREATE TABLE statement
 * so the table can be created in a standalone export DB without requiring
 * parent tables to exist.  Only strips inline column-level FK constraints;
 * table-level FOREIGN KEY constraints are also removed.
 */
function stripForeignKeys(sql: string): string {
  // Remove inline "REFERENCES table(col) [ON DELETE ...]" from column defs
  let result = sql.replace(/\s+REFERENCES\s+\S+\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+\w+(\s+\w+)?)?/gi, "");
  // Remove table-level FOREIGN KEY constraints (whole line/comma segment)
  result = result.replace(/,?\s*FOREIGN\s+KEY\s*\([^)]*\)\s+REFERENCES\s+\S+\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+\w+(\s+\w+)?)?/gi, "");
  return result;
}

// ---------------------------------------------------------------------------
// Admin full backup — copies all tables as-is
// ---------------------------------------------------------------------------

function copyAllTablesTo(destination: string) {
  // Find all tables that actually exist in the live DB and are part of ALL_TABLES
  const discoveredTables = db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type='table' AND name IN (${ALL_TABLES.map(() => "?").join(",")})`
  ).all(...ALL_TABLES) as { name: string; sql: string }[];
  const discoveredByName = new Map(discoveredTables.map((table) => [table.name, table]));
  // sqlite_master row order changes when a migration rebuilds a table. Always
  // copy in the registry's parent-before-child order so attached-DB FKs resolve.
  const existingTables = ALL_TABLES.flatMap((name) => {
    const table = discoveredByName.get(name);
    return table ? [table] : [];
  });

  db.exec(`ATTACH DATABASE ${quotedPath(destination)} AS backup_target`);
  try {
    db.exec("BEGIN");
    try {
      for (const { name, sql } of existingTables) {
        db.exec(sql.replace(/^CREATE TABLE\s+/i, "CREATE TABLE backup_target."));
        db.exec(`INSERT INTO backup_target.${name} SELECT * FROM main.${name}`);
      }
      db.exec(`PRAGMA backup_target.user_version = ${DATABASE_SCHEMA_VERSION}`);
      // Copy all non-system indexes for included tables
      const tableNames = existingTables.map(t => t.name);
      if (tableNames.length) {
        const indexes = db.prepare(
          `SELECT sql FROM sqlite_master
           WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
             AND tbl_name IN (${tableNames.map(() => "?").join(",")})`
        ).all(...tableNames) as { sql: string }[];
        for (const { sql } of indexes) {
          db.exec(sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, match => match.replace("INDEX ", "INDEX backup_target.")));
        }
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

/**
 * createBackup — admin-only full backup of the entire application database.
 * Includes all tables: users, sessions, oauth_connections, etc.
 * Only call from the admin backup route.
 */
export function createBackup(): Buffer {
  const temporary = makeTempPath("planner-backup");
  try {
    copyAllTablesTo(temporary);
    return fs.readFileSync(temporary);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Per-user export — only user-owned work data, no secrets
// ---------------------------------------------------------------------------

/**
 * createUserExport — exports only the rows belonging to `userId` from the
 * user data tables (tasks, task_plans, remote_tasks, remote_task_lists).
 *
 * Security guarantees:
 *  - The userId parameter MUST come from a server-verified session (caller's
 *    responsibility).
 *  - Sessions, auth_operations, oauth_connections, security_events
 *    and any token/secret columns are NEVER included.
 *  - Sensitive column values (encrypted_refresh_token, token_hash, etc.) are
 *    excluded even if accidentally present via schema changes.
 */
export function createUserExport(userId: number): Buffer {
  const temporary = makeTempPath("planner-export");
  try {
    db.exec(`ATTACH DATABASE ${quotedPath(temporary)} AS export_target`);
    try {
      db.exec("BEGIN");
      try {
        for (const tableName of USER_DATA_TABLES) {
          // Get the CREATE TABLE SQL from the live schema
          const row = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
          ).get(tableName) as { sql: string } | undefined;
          if (!row) continue;

          const createSql = stripForeignKeys(row.sql).replace(/^CREATE TABLE\s+/i, "CREATE TABLE export_target.");
          db.exec(createSql);

          // Get column list, excluding sensitive ones
          const columns = tableInfo(db, "main", tableName)
            .map(c => c.name)
            .filter(c => !SENSITIVE_KEYS.includes(c));

          const colList = columns.map(c => `"${c.replaceAll('"', '""')}"`).join(",");
          db.exec(
            `INSERT INTO export_target.${tableName} (${colList})
             SELECT ${colList} FROM main.${tableName} WHERE user_id = ${Number(userId)}`
          );
        }
        // Copy non-system indexes for exported tables
        const tableNames = [...USER_DATA_TABLES];
        const indexes = db.prepare(
          `SELECT sql FROM sqlite_master
           WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
             AND tbl_name IN (${tableNames.map(() => "?").join(",")})`
        ).all(...tableNames) as { sql: string }[];
        for (const { sql } of indexes) {
          db.exec(sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, match => match.replace("INDEX ", "INDEX export_target.")));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.exec("DETACH DATABASE export_target");
    }
    return fs.readFileSync(temporary);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Backup validation
// ---------------------------------------------------------------------------

/**
 * validateBackup — validates a backup database opened read-only.
 *
 * Rejects:
 *  - Corrupt databases (PRAGMA integrity_check).
 *  - Databases containing unsupported object types.
 *  - Old single-user backups that have `settings` but no `users` table.
 *  - Backups with unrecognised tables (not in ALL_TABLES).
 *  - Backups missing required tables.
 *  - Tables with newer or incompatible schemas.
 *
 * Returns the list of table names present in the backup.
 */
function validateBackup(database: DatabaseSync): string[] {
  const integrity = database.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new BackupError("Atsarginė kopija pažeista.");
  }
  const incomingVersion = Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (incomingVersion > DATABASE_SCHEMA_VERSION) {
    throw new BackupError("Atsarginės kopijos duomenų bazės schema yra naujesnė arba nepalaikoma.");
  }

  const objects = database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string; sql: string | null }[];

  if (objects.some(item => item.type !== "table" && item.type !== "index")) {
    throw new BackupError("Atsarginėje kopijoje yra nepalaikomų objektų.");
  }

  const tables = objects.filter(item => item.type === "table");
  const tableNames = new Set(tables.map(t => t.name));

  // Reject old single-user schema: has settings but no users table
  if (tableNames.has("settings") && !tableNames.has("users")) {
    throw new BackupError(
      "Sena vieno naudotojo schema — atkurimas nepalaikomas. Sukurti naują kelių naudotojų duomenų bazę."
    );
  }

  // All tables must be from the known set
  if (tables.some(item => !ALL_TABLES.includes(item.name as AllTable) || !item.sql?.startsWith("CREATE TABLE"))) {
    throw new BackupError("Atsarginėje kopijoje yra neatpažintų lentelių.");
  }

  // Required tables must be present
  for (const required of REQUIRED_TABLES) {
    if (!tableNames.has(required)) {
      throw new BackupError(`Atsarginėje kopijoje trūksta ${required} lentelės.`);
    }
  }
  if (
    incomingVersion >= 2 &&
    (!tableNames.has("calendar_preferences") || !tableNames.has("calendar_preference_sets"))
  ) {
    throw new BackupError("Atsarginėje kopijoje trūksta kelių paskyrų kalendorių pasirinkimų.");
  }

  // Column compatibility checks
  for (const table of tables) {
    const name = table.name as AllTable;
    const incoming = tableInfo(database, "main", name);
    const current = tableInfo(db, "main", name);
    const currentByName = new Map(current.map(col => [col.name, col]));

    // Reject backups with columns unknown to the live schema (newer backup)
    if (incoming.some(col => !currentByName.has(col.name) || currentByName.get(col.name)?.type.toUpperCase() !== col.type.toUpperCase())) {
      throw new BackupError(`Atsarginės kopijos ${name} schema yra naujesnė arba nepalaikoma.`);
    }

    // Required columns must be present
    if (REQUIRED_COLUMNS[name].some(col => !incoming.some(c => c.name === col))) {
      throw new BackupError(`Atsarginės kopijos ${name} schemoje trūksta būtinų stulpelių.`);
    }
    const versionedRequired =
      name === "oauth_connections" && incomingVersion >= 1
        ? ["display_label", "color_key"]
        : name === "task_plans" && incomingVersion >= 2
          ? ["mirror_connection_id"]
          : name === "auth_operations" && incomingVersion >= 3
            ? ["oauth_mode", "expected_connection_id"]
            : [];
    if (versionedRequired.some(col => !incoming.some(c => c.name === col))) {
      throw new BackupError(`Atsarginės kopijos ${name} versijuota schema nepilna.`);
    }

    // Primary key columns must be present and marked
    if (PRIMARY_KEYS[name].some(key => !incoming.some(col => col.name === key && col.pk > 0))) {
      throw new BackupError(`Atsarginės kopijos ${name} tapatybės schema nepalaikoma.`);
    }
  }

  return tables.map(t => t.name);
}

// ---------------------------------------------------------------------------
// Admin full restore
// ---------------------------------------------------------------------------

/**
 * restoreBackup — admin-only transactional restore from a full backup.
 *
 * Security:
 *  - Requires multi-user schema (users table must be present).
 *  - Rejects old single-user backups with a clear Lithuanian message.
 *  - All sessions are cleared during restore (force re-login after restore).
 *  - Only call from the admin backup route after asserting admin role.
 */
export function restoreBackup(data: Buffer): { tablesRestored: number } {
  if (data.length < 16 || !data.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) {
    throw new BackupError("Netinkamas failo formatas — reikalinga SQLite atsarginė kopija.");
  }

  const temporary = makeTempPath("planner-restore");
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    const incoming = new DatabaseSync(temporary, { readOnly: true });
    let incomingTables: string[];
    try {
      incomingTables = validateBackup(incoming);
    } finally {
      incoming.close();
    }

    db.exec(`ATTACH DATABASE ${quotedPath(temporary)} AS restore_source`);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Delete in reverse dependency order (children before parents)
        for (const table of [...ALL_TABLES].reverse()) {
          try { db.exec(`DELETE FROM main.${table}`); } catch { /* table may not exist yet */ }
        }

        for (const table of ALL_TABLES) {
          if (!incomingTables.includes(table)) continue;
          const sourceColumns = tableInfo(db, "restore_source", table).map(col => col.name);
          const destinationColumns = tableInfo(db, "main", table).map(col => col.name);
          const columns = sourceColumns.filter(col => destinationColumns.includes(col));
          if (!columns.length) {
            throw new BackupError(`Atsarginės kopijos ${table} lentelė tuščia arba nesuderinama.`);
          }
          const list = columns.map(col => `"${col.replaceAll('"', '""')}"`).join(",");
          db.exec(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM restore_source.${table}`);
        }

        // Legacy backups predate stable color keys, normalized calendar
        // preferences and mirror connection ids. Rebuild those derived values
        // before exposing the restored database.
        normalizeMultiAccountData();

        // A restored browser session would let a copied bearer cookie survive
        // the restore boundary. Force every user to authenticate again.
        db.exec("DELETE FROM auth_operations; DELETE FROM sessions;");

        const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyProblems.length > 0) {
          throw new BackupError("Atsarginės kopijos ryšiai tarp duomenų yra pažeisti.");
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
