import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";

const SENSITIVE_KEYS = [
  "google_refresh_token",
  "microsoft_refresh_token",
];

function dbPath(): string {
  const p = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "planner.db");
  return path.resolve(p);
}

function copyDbTo(dest: string, excludeSettings?: string[]) {
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as { name: string; sql: string }[];

  db.exec(`ATTACH DATABASE '${dest.replace(/'/g, "''")}' AS bk`);
  try {
    for (const { name, sql } of tables) {
      db.exec(sql.replace(/^CREATE TABLE\s+/i, "CREATE TABLE bk."));
      if (name === "settings" && excludeSettings?.length) {
        const placeholders = excludeSettings.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT * FROM main.settings WHERE key NOT IN (${placeholders})`
        ).all(...excludeSettings) as Record<string, unknown>[];
        if (rows.length) {
          const cols = Object.keys(rows[0]).join(",");
          const vals = Object.keys(rows[0]).map(() => "?").join(",");
          const ins = db.prepare(`INSERT INTO bk.settings (${cols}) VALUES (${vals})`);
          for (const row of rows) ins.run(...(Object.values(row) as import("node:sqlite").SQLInputValue[]));
        }
      } else {
        db.exec(`INSERT INTO bk.${name} SELECT * FROM main.${name}`);
      }
    }
    // Copy indexes
    const indexes = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
    ).all() as { sql: string }[];
    for (const { sql } of indexes) {
      db.exec(sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, (m) => m.replace("INDEX ", "INDEX bk.")));
    }
  } finally {
    db.exec("DETACH DATABASE bk");
  }
}

function makeTempPath(prefix: string): string {
  const p = path.join(os.tmpdir(), `${prefix}-${process.hrtime.bigint()}.db`);
  fs.closeSync(fs.openSync(p, "w", 0o600));
  return p;
}

export function createBackup(): Buffer {
  const tmp = makeTempPath("planner-backup");
  try {
    copyDbTo(tmp);
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function createExport(): Buffer {
  const tmp = makeTempPath("planner-export");
  try {
    copyDbTo(tmp, SENSITIVE_KEYS);
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function restoreBackup(data: Buffer): { tablesRestored: number } {
  if (data.length < 16 || !data.slice(0, 16).toString("utf8").startsWith("SQLite format 3")) {
    throw new Error("Netinkamas failo formatas — tikėtina SQLite duomenų bazė.");
  }
  const tmp = makeTempPath("planner-restore");
  try {
    fs.writeFileSync(tmp, data);
    const incoming = new DatabaseSync(tmp);
    let tablesRestored = 0;
    try {
      const tables = incoming.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as { name: string }[];
      const expected = new Set(["tasks", "settings"]);
      for (const { name } of tables) {
        if (!expected.has(name)) throw new Error(`Neatpažinta lentelė: ${name}`);
      }
      if (!tables.some((t) => t.name === "tasks")) throw new Error("Trūksta tasks lentelės");
      tablesRestored = tables.length;
    } finally {
      incoming.close();
    }

    // Replace live DB file
    const live = dbPath();
    const bak = live + ".pre-restore";
    fs.copyFileSync(live, bak);
    try { fs.chmodSync(bak, 0o600); } catch {}
    try {
      fs.copyFileSync(tmp, live);
      // Remove stale WAL/SHM after restore
      for (const ext of ["-wal", "-shm"]) {
        try { fs.unlinkSync(live + ext); } catch {}
      }
    } catch (err) {
      // Roll back
      fs.copyFileSync(bak, live);
      throw err;
    } finally {
      try { fs.unlinkSync(bak); } catch {}
    }
    return { tablesRestored };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
