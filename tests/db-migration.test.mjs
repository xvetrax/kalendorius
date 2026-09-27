import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(tmpdir(), "planner-legacy-schema-"));
const dbFile = path.join(temp, "test.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;

const seed = new DatabaseSync(dbFile);
seed.exec(`
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_at TEXT
  );
  INSERT INTO tasks (title, notes, due_at) VALUES ('Testiniai seni duomenys', 'nekeisti', '2026-01-01T10:00:00.000Z');
`);
seed.close();

after(() => rmSync(temp, { recursive: true, force: true }));

test("legacy single-user schema is rejected without deleting its test data", async () => {
  await assert.rejects(
    import("../lib/db-multi.ts"),
    /Rasta sena vieno naudotojo DB schema/,
  );

  const check = new DatabaseSync(dbFile, { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT title FROM tasks").get().title, "Testiniai seni duomenys");
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  } finally {
    check.close();
  }
});
