import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const temp = mkdtempSync(path.join(tmpdir(), "planner-multi-account-"));
const dbFile = path.join(temp, "legacy.db");
process.env.DATABASE_PATH = dbFile;
process.env.MULTI_USER_DATABASE_PATH = dbFile;
process.env.TOKEN_ENCRYPTION_KEY = "ef".repeat(32);

const legacy = new DatabaseSync(dbFile);
legacy.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    primary_email TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  );
  CREATE TABLE oauth_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    provider_email TEXT,
    encrypted_refresh_token TEXT,
    scopes TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider)
  );
  CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, key)
  );
  CREATE TABLE task_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_key TEXT NOT NULL,
    scheduled_at TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    schedule_version INTEGER NOT NULL DEFAULT 0,
    legacy_schedule INTEGER NOT NULL DEFAULT 0,
    mirror_requested INTEGER NOT NULL DEFAULT 0,
    mirror_event_id TEXT,
    mirror_account_id TEXT,
    mirror_transaction_id TEXT,
    mirror_error TEXT,
    mirror_create_payload TEXT,
    mirror_orphaned_at TEXT,
    mirror_orphan_title TEXT,
    project TEXT,
    tags TEXT,
    energy TEXT,
    local_priority TEXT,
    UNIQUE(user_id, task_key)
  );
  INSERT INTO users (id, display_name, primary_email, role, status)
    VALUES (7, 'Legacy user', 'legacy@example.test', 'admin', 'active');
  INSERT INTO oauth_connections
    (id, user_id, provider, provider_account_id, provider_email,
     encrypted_refresh_token, scopes, generation, status, connected_at)
    VALUES
      (41, 7, 'google', 'google-old', 'g@example.test', 'cipher-google', 'calendar tasks', 3, 'active', '2026-09-01T10:00:00Z'),
      (42, 7, 'microsoft', 'microsoft-old', 'm@example.test', 'cipher-microsoft', 'Calendars.ReadWrite', 4, 'active', '2026-09-02T10:00:00Z');
  INSERT INTO user_settings (user_id, key, value) VALUES
    (7, 'google_enabled_calendars', '{"accountId":"google-old","items":["primary",{"id":"team"}]}'),
    (7, 'microsoft_enabled_calendars', '{"accountId":"microsoft-old","items":[]}');
  INSERT INTO task_plans
    (user_id, task_key, scheduled_at, mirror_requested, mirror_event_id,
     mirror_account_id, mirror_transaction_id)
    VALUES (7, 'legacy-mirror', '2026-09-30T09:00:00Z', 1, 'event-1', 'microsoft-old', 'transaction-1');
  PRAGMA user_version = 0;
`);
legacy.close();

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

const { db, DATABASE_SCHEMA_VERSION } = await import("../lib/db-multi.ts");
const {
  AmbiguousOAuthConnectionError,
  disconnectConnection,
  getConnection,
  getConnectionByAccount,
  getConnectionById,
  listConnections,
  saveConnection,
} = await import("../lib/oauth-service.ts");
const {
  getCalendarSelection,
  replaceCalendarSelection,
  setCalendarEnabled,
} = await import("../lib/calendar-preferences.ts");
const { createBackup } = await import("../lib/backup.ts");

after(() => {
  hooks.deregister();
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

test("legacy schema migrates without changing connection identity or encrypted data", () => {
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DATABASE_SCHEMA_VERSION);
  const google = getConnectionById(7, 41, "google");
  const microsoft = getConnectionById(7, 42, "microsoft");
  assert.deepEqual(
    {
      id: google.id,
      account: google.provider_account_id,
      token: google.encrypted_refresh_token,
      scopes: google.scopes,
      generation: google.generation,
      connected: google.connected_at,
      color: google.color_key,
    },
    {
      id: 41,
      account: "google-old",
      token: "cipher-google",
      scopes: "calendar tasks",
      generation: 3,
      connected: "2026-09-01T10:00:00Z",
      color: "google:google-old",
    },
  );
  assert.equal(microsoft.id, 42);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("full backup works after oauth_connections was rebuilt by the legacy migration", () => {
  const backup = createBackup();
  assert.ok(backup.subarray(0, 16).toString("utf8").startsWith("SQLite format 3"));
});

test("legacy calendar choices preserve string items and an explicit empty selection", () => {
  const google = getCalendarSelection(7, 41);
  assert.equal(google.explicit, true);
  assert.deepEqual(google.items.map((item) => item.calendar_id), ["primary", "team"]);
  const microsoft = getCalendarSelection(7, 42);
  assert.equal(microsoft.explicit, true);
  assert.deepEqual(microsoft.items, []);
});

test("legacy Outlook mirror is bound to the uniquely matching Microsoft connection", () => {
  const mirror = db.prepare(
    "SELECT mirror_account_id, mirror_connection_id, mirror_event_id FROM task_plans WHERE user_id = 7 AND task_key = 'legacy-mirror'",
  ).get();
  assert.deepEqual({ ...mirror }, {
    mirror_account_id: "microsoft-old",
    mirror_connection_id: 42,
    mirror_event_id: "event-1",
  });
});

test("same-account upsert keeps id while a second provider account creates a sibling", () => {
  const sameId = saveConnection(7, "google", "google-old", "renamed@example.test", "cipher-new", "calendar tasks");
  assert.equal(sameId, 41);
  assert.equal(getConnectionById(7, 41).generation, 4);

  const siblingId = saveConnection(7, "google", "google-second", "second@example.test", "cipher-second", "calendar");
  assert.notEqual(siblingId, 41);
  assert.equal(listConnections(7, "google").length, 2);
  assert.throws(() => getConnection(7, "google"), AmbiguousOAuthConnectionError);
  assert.equal(getConnectionByAccount(7, "google", "google-old").id, 41);
  assert.equal(getConnectionByAccount(7, "google", "google-second").id, siblingId);
});

test("connection reads, disconnect and calendar preferences stay owner scoped", () => {
  const secondUser = Number(db.prepare(
    "INSERT INTO users (display_name, primary_email, role, status) VALUES ('Other', 'other@example.test', 'member', 'active')",
  ).run().lastInsertRowid);
  const otherConnection = saveConnection(secondUser, "microsoft", "other-ms", null, "cipher-other", "Calendars.ReadWrite");

  assert.equal(getConnectionById(7, otherConnection), null);
  assert.equal(disconnectConnection(7, otherConnection), false);
  assert.ok(getConnectionById(secondUser, otherConnection));

  assert.throws(
    () => db.prepare(
      "INSERT INTO task_plans (user_id, task_key, mirror_connection_id) VALUES (?, 'cross-owner', ?)",
    ).run(7, otherConnection),
    /mirror connection must belong to task owner/,
  );

  const empty = replaceCalendarSelection(7, 42, "microsoft-old", [], "microsoft");
  assert.equal(empty.explicit, true);
  assert.deepEqual(empty.items, []);
  const selected = setCalendarEnabled(7, 42, "microsoft-old", "work", true, "#AABBCC", "microsoft");
  assert.deepEqual(selected.items, [{ calendar_id: "work", enabled: true, color_override: "#aabbcc" }]);
  const hidden = setCalendarEnabled(7, 42, "microsoft-old", "work", false, null, "microsoft");
  assert.equal(hidden.explicit, true);
  assert.deepEqual(hidden.items, []);
});

test("schema migration is safe to execute again", async () => {
  await import("../lib/db-multi.ts?multi-account-rerun=1");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DATABASE_SCHEMA_VERSION);
  assert.equal(getConnectionById(7, 41).provider_account_id, "google-old");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});
