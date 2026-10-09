/**
 * lib/db-multi.ts — Multi-user database bootstrap (H1)
 *
 * Security constraints (non-negotiable):
 *  1. User identity resolved ONLY from server-verified DB session, NEVER from client-sent userId.
 *  2. Every DB operation for user data requires userId param.
 *  3. OAuth refresh tokens stored AES-256-GCM encrypted, never in settings.
 *  4. Session tokens stored as SHA-256 hash in DB; raw token only in HttpOnly cookie.
 *  5. assertSameOrigin() on ALL mutating routes.
 *  6. New verified OIDC identities create their own member account automatically.
 *  7. Admin role does NOT access other users' tasks, calendar data, or OAuth tokens.
 *  8. OIDC login scope: openid+email+profile only.
 *  9. No automatic account merging by email.
 * 10. The first account is admin; later accounts are members unless an existing admin promotes them.
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const dbPath = isBuild
  ? ":memory:"
  : process.env.MULTI_USER_DATABASE_PATH ||
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "planner.db");

if (!isBuild && dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const globalDb = globalThis as typeof globalThis & { plannerMultiDb?: DatabaseSync };
export const db = globalDb.plannerMultiDb ?? new DatabaseSync(dbPath);
if (process.env.NODE_ENV !== "production") globalDb.plannerMultiDb = db;

const existingTaskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
if (existingTaskColumns.length > 0 && !existingTaskColumns.some((column) => column.name === "user_id")) {
  throw new Error(
    "Rasta sena vieno naudotojo DB schema. Duomenys testiniai: sustabdyk programą, pašalink DATABASE_PATH failą ir paleisk iš naujo.",
  );
}

// ---------------------------------------------------------------------------
// Schema — applied in dependency order
// ---------------------------------------------------------------------------

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name  TEXT    NOT NULL,
    primary_email TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK(role IN ('admin', 'member')),
    status        TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_users_email  ON users(primary_email);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

  CREATE TABLE IF NOT EXISTS auth_identities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider      TEXT    NOT NULL,
    issuer        TEXT    NOT NULL,
    subject       TEXT    NOT NULL,
    display_email TEXT,
    UNIQUE(issuer, subject)
  );

  CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT    NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TEXT    NOT NULL,
    last_used_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS auth_operations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    state_hash    TEXT    NOT NULL UNIQUE,
    nonce         TEXT    NOT NULL,
    pkce_verifier TEXT    NOT NULL,
    provider      TEXT    NOT NULL CHECK(provider IN ('google', 'microsoft')),
    session_id    INTEGER REFERENCES sessions(id),
    callback_path TEXT    NOT NULL,
    expires_at    TEXT    NOT NULL,
    used          INTEGER NOT NULL DEFAULT 0,
    oauth_mode    TEXT    NOT NULL DEFAULT 'legacy'
      CHECK(oauth_mode IN ('legacy', 'add', 'reconsent')),
    expected_connection_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_auth_operations_expires ON auth_operations(expires_at) WHERE used = 0;

  CREATE TABLE IF NOT EXISTS oauth_connections (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider                TEXT    NOT NULL CHECK(provider IN ('google', 'microsoft')),
    provider_account_id     TEXT    NOT NULL,
    provider_email          TEXT,
    encrypted_refresh_token TEXT,
    scopes                  TEXT    NOT NULL DEFAULT '',
    generation              INTEGER NOT NULL DEFAULT 1,
    status                  TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'error')),
    connected_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    display_label           TEXT,
    color_key               TEXT    NOT NULL DEFAULT '',
    UNIQUE(user_id, provider, provider_account_id),
    UNIQUE(id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_connections_user    ON oauth_connections(user_id);
  CREATE INDEX IF NOT EXISTS idx_oauth_connections_account ON oauth_connections(provider, provider_account_id);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint_hash   TEXT    NOT NULL UNIQUE,
    encrypted_subscription TEXT NOT NULL,
    device_name     TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_test_attempt_at TEXT,
    last_push_accepted_at TEXT,
    failure_count   INTEGER NOT NULL DEFAULT 0
      CHECK(failure_count >= 0)
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions(user_id, created_at);

  CREATE TABLE IF NOT EXISTS push_rate_limits (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_test_attempt_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario        TEXT    NOT NULL CHECK(scenario IN ('focus_end', 'task_start', 'morning_plan', 'evening_close')),
    enabled         INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    lead_minutes    INTEGER CHECK(lead_minutes IS NULL OR (lead_minutes >= 0 AND lead_minutes <= 1440)),
    local_time      TEXT,
    time_zone       TEXT,
    private_content INTEGER NOT NULL DEFAULT 0 CHECK(private_content IN (0, 1)),
    updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, scenario)
  );

  CREATE TABLE IF NOT EXISTS notification_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario     TEXT    NOT NULL CHECK(scenario IN ('focus_end', 'task_start', 'morning_plan', 'evening_close')),
    source_key   TEXT    NOT NULL,
    run_at       TEXT    NOT NULL,
    expires_at   TEXT    NOT NULL,
    cancelled_at TEXT,
    expanded_at  TEXT,
    completed_at TEXT,
    created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, scenario, source_key)
  );

  CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
    ON notification_jobs(run_at, id)
    WHERE cancelled_at IS NULL AND completed_at IS NULL;

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id            INTEGER NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
    subscription_id   INTEGER REFERENCES push_subscriptions(id) ON DELETE SET NULL,
    state             TEXT    NOT NULL DEFAULT 'queued'
      CHECK(state IN ('queued', 'leased', 'sending', 'accepted', 'retryable', 'permanent', 'ambiguous', 'cancelled')),
    lease_owner       TEXT,
    lease_until       TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at   TEXT,
    attempted_at      TEXT,
    accepted_at       TEXT,
    last_status_class TEXT,
    error_code        TEXT,
    created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, subscription_id)
  );

  CREATE INDEX IF NOT EXISTS idx_notification_deliveries_ready
    ON notification_deliveries(state, next_attempt_at, id);

  CREATE TABLE IF NOT EXISTS notification_runtime (
    id           INTEGER PRIMARY KEY CHECK(id = 1),
    paused       INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
    generation   INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
    in_flight    INTEGER NOT NULL DEFAULT 0 CHECK(in_flight >= 0),
    pause_until  TEXT,
    pause_owner  TEXT,
    heartbeat_at TEXT,
    worker_id    TEXT,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO notification_runtime (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS security_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    event_type TEXT    NOT NULL,
    ip_hint    TEXT,
    details    TEXT,
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_security_events_user    ON security_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_security_events_type    ON security_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT    NOT NULL,
    notes            TEXT    NOT NULL DEFAULT '',
    due_at           TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    completed        INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    project          TEXT    NOT NULL DEFAULT 'Asmeniniai',
    priority         TEXT    NOT NULL DEFAULT 'normal',
    energy           TEXT    NOT NULL DEFAULT 'medium',
    tags             TEXT    NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_at  ON tasks(user_id, due_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_open    ON tasks(user_id, completed) WHERE completed = 0;

  CREATE TABLE IF NOT EXISTS task_plans (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_key              TEXT    NOT NULL,
    scheduled_at          TEXT,
    duration_minutes      INTEGER NOT NULL DEFAULT 30,
    schedule_version      INTEGER NOT NULL DEFAULT 0,
    legacy_schedule       INTEGER NOT NULL DEFAULT 0,
    mirror_requested      INTEGER NOT NULL DEFAULT 0,
    mirror_event_id       TEXT,
    mirror_account_id     TEXT,
    mirror_connection_id  INTEGER REFERENCES oauth_connections(id) ON DELETE SET NULL,
    mirror_transaction_id TEXT,
    mirror_error          TEXT,
    mirror_create_payload TEXT,
    mirror_orphaned_at    TEXT,
    mirror_orphan_title   TEXT,
    project               TEXT,
    tags                  TEXT,
    energy                TEXT,
    local_priority        TEXT,
    UNIQUE(user_id, task_key)
  );

  CREATE INDEX IF NOT EXISTS idx_task_plans_user   ON task_plans(user_id);
  CREATE INDEX IF NOT EXISTS idx_task_plans_mirror ON task_plans(user_id, mirror_orphaned_at)
    WHERE mirror_orphaned_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS action_journal (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id    TEXT    NOT NULL,
    action_type     TEXT    NOT NULL CHECK(action_type IN ('local_task_created','local_task_completed','local_task_planned','local_task_moved','local_task_resized','local_task_unplanned','provider_task_planned','provider_task_moved','provider_task_resized','provider_task_unplanned','provider_event_moved','provider_event_resized')),
    entity_type     TEXT    NOT NULL CHECK(entity_type IN ('local_task','provider_task','provider_event')),
    entity_key      TEXT    NOT NULL,
    label           TEXT    NOT NULL,
    before_json     TEXT,
    after_json      TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'available' CHECK(status IN ('available','applying','undone','conflict')),
    undo_expires_at TEXT    NOT NULL,
    retained_until  TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at      TEXT,
    UNIQUE(user_id, operation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_action_journal_user_created ON action_journal(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_action_journal_retention ON action_journal(retained_until);

  CREATE TABLE IF NOT EXISTS remote_tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_key   TEXT    NOT NULL,
    account_id TEXT    NOT NULL,
    list_id    TEXT    NOT NULL,
    task_json  TEXT    NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'microsoft',
    UNIQUE(user_id, task_key)
  );

  CREATE INDEX IF NOT EXISTS idx_remote_tasks_user    ON remote_tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_remote_tasks_account ON remote_tasks(user_id, account_id, source);

  CREATE TABLE IF NOT EXISTS remote_task_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list_key   TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    account_id TEXT    NOT NULL,
    list_json  TEXT    NOT NULL,
    UNIQUE(user_id, list_key)
  );

  CREATE INDEX IF NOT EXISTS idx_remote_task_lists_user    ON remote_task_lists(user_id);
  CREATE INDEX IF NOT EXISTS idx_remote_task_lists_account ON remote_task_lists(user_id, source, account_id);

  CREATE TABLE IF NOT EXISTS calendar_event_creates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider      TEXT    NOT NULL,
    account_id    TEXT    NOT NULL,
    connection_id TEXT    NOT NULL,
    calendar_id   TEXT    NOT NULL,
    operation_id  TEXT    NOT NULL,
    fingerprint   TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, account_id, connection_id, calendar_id, operation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_event_creates_user ON calendar_event_creates(user_id);

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

// v1: oauth_connections supports more than one account per provider.
// v2: normalized calendar preferences and connection-bound Outlook mirrors.
// v3: OAuth data-consent operations persist add/re-consent intent.
// v4: encrypted, user-scoped Web Push subscriptions and persistent send throttles.
// v5: notification preferences, durable jobs and per-device delivery state.
// v6: user-scoped local-task action history with short-lived undo capabilities.
// v7: provider-task planning and provider-calendar move undo journal entries.
export const DATABASE_SCHEMA_VERSION = 7;

type SqliteColumn = { name: string };
type SqliteIndex = { name: string; unique: number };

function tableColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as SqliteColumn[])
    .map((column) => column.name);
}

function hasUniqueIndex(table: string, columns: readonly string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list("${table.replaceAll('"', '""')}")`).all() as SqliteIndex[];
  return indexes.some((index) => {
    if (!index.unique) return false;
    const escaped = index.name.replaceAll('"', '""');
    const names = (db.prepare(`PRAGMA index_info("${escaped}")`).all() as { name: string }[])
      .map((column) => column.name);
    return names.length === columns.length && names.every((name, position) => name === columns[position]);
  });
}

function recordPreferenceMigrationIssue(userId: number, provider: string, reason: string): void {
  db.prepare(
    `INSERT INTO security_events (user_id, event_type, details)
     VALUES (?, 'calendar_preferences_migration_skipped', ?)`,
  ).run(userId, JSON.stringify({ provider, reason }));
}

function migrateLegacyCalendarPreferences(): void {
  const settings = db.prepare(
    `SELECT user_id, key, value, updated_at
     FROM user_settings
     WHERE key IN ('google_enabled_calendars', 'microsoft_enabled_calendars')`,
  ).all() as { user_id: number; key: string; value: string; updated_at: string }[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO calendar_preferences
       (user_id, connection_id, calendar_id, enabled, updated_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
  );
  const markExplicit = db.prepare(
    `INSERT INTO calendar_preference_sets
       (user_id, connection_id, explicit, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, connection_id) DO UPDATE SET
       explicit = 1,
       updated_at = excluded.updated_at`,
  );

  for (const setting of settings) {
    const provider = setting.key.startsWith("google_") ? "google" : "microsoft";
    try {
      const parsed = JSON.parse(setting.value) as { accountId?: unknown; items?: unknown } | unknown[];
      const accountId = Array.isArray(parsed) ? null : parsed.accountId;
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items) || (accountId !== null && typeof accountId !== "string")) {
        recordPreferenceMigrationIssue(setting.user_id, provider, "invalid_setting_shape");
        continue;
      }
      const connections = accountId === null
        ? db.prepare(
          `SELECT id FROM oauth_connections
           WHERE user_id = ? AND provider = ? AND status = 'active'
           ORDER BY id LIMIT 2`,
        ).all(setting.user_id, provider) as { id: number }[]
        : db.prepare(
          `SELECT id FROM oauth_connections
           WHERE user_id = ? AND provider = ? AND provider_account_id = ?`,
        ).all(setting.user_id, provider, accountId) as { id: number }[];
      const connection = connections.length === 1 ? connections[0] : undefined;
      if (!connection) {
        recordPreferenceMigrationIssue(
          setting.user_id,
          provider,
          connections.length > 1 ? "ambiguous_connection" : "connection_not_found",
        );
        continue;
      }
      const existingSet = db.prepare(
        `SELECT updated_at FROM calendar_preference_sets
         WHERE user_id = ? AND connection_id = ?`,
      ).get(setting.user_id, connection.id) as { updated_at: string } | undefined;
      if (
        existingSet &&
        Number.isFinite(Date.parse(existingSet.updated_at)) &&
        Date.parse(existingSet.updated_at) >= Date.parse(setting.updated_at)
      ) {
        continue;
      }
      db.prepare(
        "DELETE FROM calendar_preferences WHERE user_id = ? AND connection_id = ?",
      ).run(setting.user_id, connection.id);
      markExplicit.run(setting.user_id, connection.id);
      for (const item of items) {
        const calendarId = typeof item === "string"
          ? item
          : item && typeof item === "object" && "id" in item
            ? (item as { id?: unknown }).id
            : undefined;
        if (typeof calendarId === "string" && calendarId) {
          insert.run(setting.user_id, connection.id, calendarId);
        }
      }
    } catch {
      recordPreferenceMigrationIssue(setting.user_id, provider, "invalid_json");
    }
  }
}

function backfillMirrorConnections(): void {
  db.exec(`
    UPDATE task_plans
    SET mirror_connection_id = (
      SELECT MIN(oc.id)
      FROM oauth_connections oc
      WHERE oc.user_id = task_plans.user_id
        AND oc.provider = 'microsoft'
        AND oc.provider_account_id = task_plans.mirror_account_id
    )
    WHERE mirror_connection_id IS NULL
      AND mirror_account_id IS NOT NULL
      AND (
        SELECT COUNT(*)
        FROM oauth_connections oc
        WHERE oc.user_id = task_plans.user_id
          AND oc.provider = 'microsoft'
          AND oc.provider_account_id = task_plans.mirror_account_id
      ) = 1;
  `);

  const unresolved = db.prepare(
    `SELECT user_id, COUNT(*) AS count
     FROM task_plans
     WHERE mirror_connection_id IS NULL
       AND mirror_account_id IS NOT NULL
       AND (mirror_event_id IS NOT NULL OR mirror_transaction_id IS NOT NULL
            OR mirror_create_payload IS NOT NULL OR mirror_requested <> 0)
     GROUP BY user_id`,
  ).all() as { user_id: number; count: number }[];
  for (const item of unresolved) {
    db.prepare(
      `INSERT INTO security_events (user_id, event_type, details)
       VALUES (?, 'mirror_connection_migration_unresolved', ?)`,
    ).run(item.user_id, JSON.stringify({ count: item.count }));
  }
}

/**
 * Rebuild derived multi-account metadata after a legacy migration or restore.
 * The old settings remain in place throughout the compatibility window.
 */
export function normalizeMultiAccountData(): void {
  db.exec(`
    UPDATE oauth_connections
    SET color_key = provider || ':' || provider_account_id
    WHERE color_key = '';
  `);
  migrateLegacyCalendarPreferences();
  backfillMirrorConnections();
}

function migrateMultiAccountSchema(): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Inspect only after acquiring the write lock. Two app processes may start
    // against the same database, and the second must observe the first migration.
    const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Duomenų bazės schema (${currentVersion}) naujesnė už programos palaikomą (${DATABASE_SCHEMA_VERSION})`,
      );
    }
    const oauthColumns = tableColumns("oauth_connections");
    const needsOAuthRebuild =
      !oauthColumns.includes("display_label") ||
      !oauthColumns.includes("color_key") ||
      !hasUniqueIndex("oauth_connections", ["user_id", "provider", "provider_account_id"]);

    if (needsOAuthRebuild) {
      db.exec(`
        ALTER TABLE oauth_connections RENAME TO oauth_connections_ma1_legacy;

        CREATE TABLE oauth_connections (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider                TEXT    NOT NULL CHECK(provider IN ('google', 'microsoft')),
          provider_account_id     TEXT    NOT NULL,
          provider_email          TEXT,
          encrypted_refresh_token TEXT,
          scopes                  TEXT    NOT NULL DEFAULT '',
          generation              INTEGER NOT NULL DEFAULT 1,
          status                  TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'error')),
          connected_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          display_label           TEXT,
          color_key               TEXT    NOT NULL DEFAULT '',
          UNIQUE(user_id, provider, provider_account_id),
          UNIQUE(id, user_id)
        );

        INSERT INTO oauth_connections
          (id, user_id, provider, provider_account_id, provider_email,
           encrypted_refresh_token, scopes, generation, status, connected_at,
           display_label, color_key)
        SELECT id, user_id, provider, provider_account_id, provider_email,
               encrypted_refresh_token, scopes, generation, status, connected_at,
               NULL, provider || ':' || provider_account_id
        FROM oauth_connections_ma1_legacy;
      `);

      const legacyCount = (db.prepare("SELECT COUNT(*) AS count FROM oauth_connections_ma1_legacy").get() as { count: number }).count;
      const migratedCount = (db.prepare("SELECT COUNT(*) AS count FROM oauth_connections").get() as { count: number }).count;
      if (legacyCount !== migratedCount) {
        throw new Error("OAuth jungčių migracija neišsaugojo visų eilučių");
      }

      db.exec("DROP TABLE oauth_connections_ma1_legacy");
    }

    const taskPlanColumns = tableColumns("task_plans");
    if (!taskPlanColumns.includes("mirror_connection_id")) {
      db.exec(
        "ALTER TABLE task_plans ADD COLUMN mirror_connection_id INTEGER REFERENCES oauth_connections(id) ON DELETE SET NULL",
      );
    }

    const authOperationColumns = tableColumns("auth_operations");
    if (!authOperationColumns.includes("oauth_mode")) {
      db.exec(
        "ALTER TABLE auth_operations ADD COLUMN oauth_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(oauth_mode IN ('legacy', 'add', 'reconsent'))",
      );
    }
    if (!authOperationColumns.includes("expected_connection_id")) {
      db.exec("ALTER TABLE auth_operations ADD COLUMN expected_connection_id INTEGER");
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_oauth_connections_user
        ON oauth_connections(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_connections_account
        ON oauth_connections(provider, provider_account_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_connections_user_provider_status
        ON oauth_connections(user_id, provider, status);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint_hash   TEXT    NOT NULL UNIQUE,
        encrypted_subscription TEXT NOT NULL,
        device_name     TEXT    NOT NULL,
        created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_test_attempt_at TEXT,
        last_push_accepted_at TEXT,
        failure_count   INTEGER NOT NULL DEFAULT 0
          CHECK(failure_count >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
        ON push_subscriptions(user_id, created_at);

      CREATE TABLE IF NOT EXISTS push_rate_limits (
        user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_test_attempt_at TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scenario        TEXT    NOT NULL CHECK(scenario IN ('focus_end', 'task_start', 'morning_plan', 'evening_close')),
        enabled         INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        lead_minutes    INTEGER CHECK(lead_minutes IS NULL OR (lead_minutes >= 0 AND lead_minutes <= 1440)),
        local_time      TEXT,
        time_zone       TEXT,
        private_content INTEGER NOT NULL DEFAULT 0 CHECK(private_content IN (0, 1)),
        updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, scenario)
      );

      CREATE TABLE IF NOT EXISTS notification_jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scenario     TEXT    NOT NULL CHECK(scenario IN ('focus_end', 'task_start', 'morning_plan', 'evening_close')),
        source_key   TEXT    NOT NULL,
        run_at       TEXT    NOT NULL,
        expires_at   TEXT    NOT NULL,
        cancelled_at TEXT,
        expanded_at  TEXT,
        completed_at TEXT,
        created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, scenario, source_key)
      );

      CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
        ON notification_jobs(run_at, id)
        WHERE cancelled_at IS NULL AND completed_at IS NULL;

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id            INTEGER NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
        subscription_id   INTEGER REFERENCES push_subscriptions(id) ON DELETE SET NULL,
        state             TEXT    NOT NULL DEFAULT 'queued'
          CHECK(state IN ('queued', 'leased', 'sending', 'accepted', 'retryable', 'permanent', 'ambiguous', 'cancelled')),
        lease_owner       TEXT,
        lease_until       TEXT,
        attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        next_attempt_at   TEXT,
        attempted_at      TEXT,
        accepted_at       TEXT,
        last_status_class TEXT,
        error_code        TEXT,
        created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(job_id, subscription_id)
      );

      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_ready
        ON notification_deliveries(state, next_attempt_at, id);

      CREATE TABLE IF NOT EXISTS notification_runtime (
        id           INTEGER PRIMARY KEY CHECK(id = 1),
        paused       INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
        generation   INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
        in_flight    INTEGER NOT NULL DEFAULT 0 CHECK(in_flight >= 0),
        pause_until  TEXT,
        pause_owner  TEXT,
        heartbeat_at TEXT,
        worker_id    TEXT,
        updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO notification_runtime (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS calendar_preferences (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id INTEGER NOT NULL,
        calendar_id   TEXT    NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        color_override TEXT,
        updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, connection_id, calendar_id),
        FOREIGN KEY(connection_id, user_id)
          REFERENCES oauth_connections(id, user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_preferences_connection
        ON calendar_preferences(user_id, connection_id);

      CREATE TABLE IF NOT EXISTS action_journal (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation_id    TEXT    NOT NULL,
        action_type     TEXT    NOT NULL CHECK(action_type IN ('local_task_created','local_task_completed','local_task_planned','local_task_moved','local_task_resized','local_task_unplanned','provider_task_planned','provider_task_moved','provider_task_resized','provider_task_unplanned','provider_event_moved','provider_event_resized')),
        entity_type     TEXT    NOT NULL CHECK(entity_type IN ('local_task','provider_task','provider_event')),
        entity_key      TEXT    NOT NULL,
        label           TEXT    NOT NULL,
        before_json     TEXT,
        after_json      TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'available' CHECK(status IN ('available','applying','undone','conflict')),
        undo_expires_at TEXT    NOT NULL,
        retained_until  TEXT    NOT NULL,
        created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_at      TEXT,
        UNIQUE(user_id, operation_id)
      );

      CREATE INDEX IF NOT EXISTS idx_action_journal_user_created ON action_journal(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_action_journal_retention ON action_journal(retained_until);

      CREATE TABLE IF NOT EXISTS calendar_preference_sets (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id INTEGER NOT NULL,
        explicit      INTEGER NOT NULL DEFAULT 0 CHECK(explicit IN (0, 1)),
        updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, connection_id),
        FOREIGN KEY(connection_id, user_id)
          REFERENCES oauth_connections(id, user_id) ON DELETE CASCADE
      );

      CREATE TRIGGER IF NOT EXISTS trg_task_plans_mirror_connection_insert
      BEFORE INSERT ON task_plans
      WHEN NEW.mirror_connection_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM oauth_connections
         WHERE id = NEW.mirror_connection_id
           AND user_id = NEW.user_id
           AND provider = 'microsoft'
       )
      BEGIN
        SELECT RAISE(ABORT, 'mirror connection must belong to task owner');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_task_plans_mirror_connection_update
      BEFORE UPDATE OF mirror_connection_id, user_id ON task_plans
      WHEN NEW.mirror_connection_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM oauth_connections
         WHERE id = NEW.mirror_connection_id
           AND user_id = NEW.user_id
           AND provider = 'microsoft'
       )
      BEGIN
        SELECT RAISE(ABORT, 'mirror connection must belong to task owner');
      END;
    `);

    const notificationRuntimeColumns = tableColumns("notification_runtime");
    if (!notificationRuntimeColumns.includes("pause_until")) {
      db.exec("ALTER TABLE notification_runtime ADD COLUMN pause_until TEXT");
    }
    if (!notificationRuntimeColumns.includes("pause_owner")) {
      db.exec("ALTER TABLE notification_runtime ADD COLUMN pause_owner TEXT");
    }

    if (currentVersion < 7) {
      db.exec(`
        DROP INDEX IF EXISTS idx_action_journal_user_created;
        DROP INDEX IF EXISTS idx_action_journal_retention;
        ALTER TABLE action_journal RENAME TO action_journal_v6;
        CREATE TABLE action_journal (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          operation_id    TEXT    NOT NULL,
          action_type     TEXT    NOT NULL CHECK(action_type IN ('local_task_created','local_task_completed','local_task_planned','local_task_moved','local_task_resized','local_task_unplanned','provider_task_planned','provider_task_moved','provider_task_resized','provider_task_unplanned','provider_event_moved','provider_event_resized')),
          entity_type     TEXT    NOT NULL CHECK(entity_type IN ('local_task','provider_task','provider_event')),
          entity_key      TEXT    NOT NULL,
          label           TEXT    NOT NULL,
          before_json     TEXT,
          after_json      TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'available' CHECK(status IN ('available','applying','undone','conflict')),
          undo_expires_at TEXT    NOT NULL,
          retained_until  TEXT    NOT NULL,
          created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          applied_at      TEXT,
          UNIQUE(user_id, operation_id)
        );
        INSERT INTO action_journal
          (id,user_id,operation_id,action_type,entity_type,entity_key,label,before_json,after_json,status,undo_expires_at,retained_until,created_at,applied_at)
        SELECT id,user_id,operation_id,action_type,entity_type,entity_key,label,before_json,after_json,status,undo_expires_at,retained_until,created_at,applied_at
        FROM action_journal_v6;
        DROP TABLE action_journal_v6;
        CREATE INDEX idx_action_journal_user_created ON action_journal(user_id, created_at DESC);
        CREATE INDEX idx_action_journal_retention ON action_journal(retained_until);
      `);
    }

    if (currentVersion < 2) {
      normalizeMultiAccountData();
    }

    const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyProblems.length > 0) {
      throw new Error("Kelių paskyrų schemos migracija pažeidė išorinius raktus");
    }

    db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

migrateMultiAccountSchema();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "planner_session";
export const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_DURATION_MS = SESSION_DURATION_SECONDS * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIso(durationMs: number): string {
  return new Date(Date.now() + durationMs).toISOString();
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: number;
  token_hash: string;
  user_id: number;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

export interface UserContext {
  id: number;
  role: "admin" | "member";
}

/**
 * createSession — generates 32 random bytes as raw token, stores SHA-256 hash,
 * returns raw token for the HttpOnly cookie.
 */
export function createSession(userId: number): { rawToken: string; sessionId: number } {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = expiryIso(SESSION_DURATION_MS);

  const result = db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, last_used_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, expiresAt, nowIso());

  return { rawToken, sessionId: Number(result.lastInsertRowid) };
}

/**
 * getUserFromSession — takes raw token, hashes it, looks up in sessions table,
 * checks expiry/revoked. Updates last_used_at on each verified request.
 * Returns UserContext or null if session is invalid/expired.
 */
export function getUserFromSession(rawToken: string): UserContext | null {
  const tokenHash = sha256Hex(rawToken);

  const session = db.prepare(`
    SELECT id, user_id, expires_at, revoked_at
    FROM sessions
    WHERE token_hash = ?
  `).get(tokenHash) as { id: number; user_id: number; expires_at: string; revoked_at: string | null } | undefined;

  if (!session) return null;
  if (session.revoked_at !== null) return null;
  if (new Date(session.expires_at) <= new Date()) return null;

  // Active users keep a rolling session. The browser cookie is refreshed on
  // protected page navigations by proxy.ts to the same 30-day boundary.
  db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?")
    .run(nowIso(), expiryIso(SESSION_DURATION_MS), session.id);

  // Load user and check status
  const user = db.prepare(`
    SELECT id, role, status FROM users WHERE id = ? AND status = 'active'
  `).get(session.user_id) as { id: number; role: "admin" | "member"; status: string } | undefined;

  if (!user) {
    // User disabled — revoke the session
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(nowIso(), session.id);
    return null;
  }

  return { id: user.id, role: user.role };
}

/** Persistent first-party session cookie used by both OIDC callbacks and the
 * protected-page refresh in proxy.ts. Expires complements Max-Age for WebKit
 * web-app compatibility; Max-Age remains authoritative where both exist. */
export function sessionCookieHeader(rawToken: string, origin: string, now = new Date()): string {
  const expires = new Date(now.getTime() + SESSION_DURATION_MS).toUTCString();
  return [
    `${SESSION_COOKIE}=${rawToken}`,
    "Path=/",
    `Max-Age=${SESSION_DURATION_SECONDS}`,
    `Expires=${expires}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(origin.startsWith("https://") ? ["Secure"] : []),
  ].join("; ");
}

/**
 * revokeSession — revokes a single session by its DB id.
 */
export function revokeSession(sessionId: number): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(nowIso(), sessionId);
}

/**
 * revokeAllUserSessions — revokes all active sessions for a user.
 */
export function revokeAllUserSessions(userId: number): void {
  db.prepare(`
    UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
  `).run(nowIso(), userId);
}

/**
 * requireUserContext — resolves UserContext from the session cookie in the
 * incoming Request. Throws a Response with status 401 if missing or expired.
 *
 * NEVER accepts a userId from the request body, query string, or headers.
 */
export function requireUserContext(request: Request): UserContext {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const rawToken = parseCookieValue(cookieHeader, SESSION_COOKIE);

  if (!rawToken) {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = getUserFromSession(rawToken);
  if (!ctx) {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Cookie parser (minimal, no external dependency)
// ---------------------------------------------------------------------------

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}
