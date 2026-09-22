import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const temp = mkdtempSync(path.join(tmpdir(), "planner-backup-test-"));
const dbFile = path.join(temp, "backup-test.db");
process.env.DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);

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

describe("backup", () => {
  let db, createBackup, createExport, restoreBackup;

  before(async () => {
    ({ db } = await import("../lib/db.ts"));
    ({ createBackup, createExport, restoreBackup } = await import("../lib/backup.ts"));

    db.prepare("INSERT INTO tasks (title, notes) VALUES (?, ?)").run("Backup task", "Notes");
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("google_refresh_token", "SECRET_TOKEN");
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("color_theme", "dark");
  });

  it("createBackup returns a SQLite file", () => {
    const buf = createBackup();
    assert.ok(buf.toString("utf8", 0, 16).startsWith("SQLite format 3"), "Not SQLite magic bytes");
  });

  it("backup includes all tasks and sensitive tokens", () => {
    const buf = createBackup();
    const tmp = path.join(temp, "check-backup.db");
    writeFileSync(tmp, buf);
    const d = new DatabaseSync(tmp);
    const tasks = d.prepare("SELECT title FROM tasks").all();
    assert.ok(tasks.some((t) => t.title === "Backup task"), "tasks missing from backup");
    const token = d.prepare("SELECT value FROM settings WHERE key='google_refresh_token'").get();
    assert.equal(token?.value, "SECRET_TOKEN", "token should be in full backup");
    d.close();
  });

  it("createExport excludes sensitive token keys but keeps other settings", () => {
    const buf = createExport();
    const tmp = path.join(temp, "check-export.db");
    writeFileSync(tmp, buf);
    const d = new DatabaseSync(tmp);
    const tasks = d.prepare("SELECT title FROM tasks").all();
    assert.ok(tasks.some((t) => t.title === "Backup task"), "tasks missing from export");
    const token = d.prepare("SELECT value FROM settings WHERE key='google_refresh_token'").get();
    assert.equal(token, undefined, "refresh_token should be excluded from export");
    const theme = d.prepare("SELECT value FROM settings WHERE key='color_theme'").get();
    assert.equal(theme?.value, "dark", "non-sensitive settings should be present");
    d.close();
  });

  it("restoreBackup rejects non-SQLite data", () => {
    assert.throws(() => restoreBackup(Buffer.from("definitely not sqlite")), /netinkamas/i);
  });

  it("restoreBackup rejects DB with unknown tables", () => {
    const badPath = path.join(temp, "bad.db");
    const bad = new DatabaseSync(badPath);
    bad.exec("CREATE TABLE unknown_alien_table (x TEXT)");
    bad.close();
    import("node:fs").then(({ readFileSync }) => {
      const buf = readFileSync(badPath);
      assert.throws(() => restoreBackup(buf), /neatpažinta/i);
    });
  });
});
