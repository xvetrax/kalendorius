-- Multi-user schema for Kalendorius / Dienos Planas
-- Replaces the single-user tables that lack owner columns.
-- This file is the authoritative DDL contract for H0–H8.
-- The current single-user DB is treated as test data and is NOT migrated.
-- A fresh empty DB is initialised from this script when multi-user mode starts.
--
-- Encoding: UTF-8.  PRAGMA foreign_keys = ON must be set per connection.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- ---------------------------------------------------------------------------
-- Core identity tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT    NOT NULL,
  primary_email TEXT   NOT NULL,                -- informational; not used for identity matching
  role         TEXT    NOT NULL CHECK(role IN ('admin', 'member')),
  status       TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
  created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT                             -- NULL until first successful login
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users(primary_email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ---------------------------------------------------------------------------
-- OIDC / social login identities (issuer + subject, never raw email)
-- One user may have multiple identities (e.g. Google + Microsoft login).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,               -- 'google' | 'microsoft'
  issuer        TEXT    NOT NULL,               -- OIDC issuer URL verified from token
  subject       TEXT    NOT NULL,               -- OIDC sub claim
  display_email TEXT,                           -- shown in UI; NOT used for auth decisions
  UNIQUE(issuer, subject)                       -- uniqueness by verified token claims only
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

-- ---------------------------------------------------------------------------
-- Sessions (DB-backed; raw token only in HttpOnly cookie)
-- token_hash = SHA-256(raw_token) in hex.
-- Revoked rows kept for audit; a background job may purge after 90 days.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,         -- SHA-256(raw cookie token) hex
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT    NOT NULL,                -- ISO-8601
  last_used_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   TEXT                             -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Invites (admin-generated one-time links; token stored as hash)
-- token_hash = SHA-256(raw_token) hex.  Raw token is delivered out-of-band.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash      TEXT    NOT NULL UNIQUE,      -- SHA-256(raw invite token) hex
  recipient_email TEXT,                         -- optional hint shown to invitee; not enforced
  role            TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_by      INTEGER NOT NULL REFERENCES users(id),
  expires_at      TEXT    NOT NULL,             -- ISO-8601
  used_at         TEXT,                         -- NULL = not yet used
  used_by         INTEGER REFERENCES users(id) -- set atomically when invite is consumed
);

CREATE INDEX IF NOT EXISTS idx_invites_used ON invites(used_at) WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- Auth operations (short-lived OIDC / OAuth flows)
-- state_hash = SHA-256(state) hex, so the raw state parameter is never stored.
-- Supports both initial login and identity-linking from an existing session.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  state_hash    TEXT    NOT NULL UNIQUE,        -- SHA-256(OAuth state param) hex
  nonce         TEXT    NOT NULL,               -- OIDC nonce (stored in DB, verified in id_token)
  pkce_verifier TEXT    NOT NULL,               -- PKCE code_verifier (stored in DB only)
  provider      TEXT    NOT NULL CHECK(provider IN ('google', 'microsoft')),
  invite_id     INTEGER REFERENCES invites(id), -- set when flow was initiated via an invite link
  session_id    INTEGER REFERENCES sessions(id),-- set when flow was initiated by a logged-in user
  callback_path TEXT    NOT NULL,               -- e.g. '/api/google/callback'
  expires_at    TEXT    NOT NULL,               -- ISO-8601; operation must complete before this
  used          INTEGER NOT NULL DEFAULT 0      -- 1 once callback has been processed; prevents replay
);

CREATE INDEX IF NOT EXISTS idx_auth_operations_expires ON auth_operations(expires_at) WHERE used = 0;

-- ---------------------------------------------------------------------------
-- OAuth connections (Calendar / Tasks scopes; separate from login identity)
-- One active connection per user per provider (UNIQUE(user_id, provider)).
-- Encrypted refresh token uses AES-256-GCM; encrypted value stored as base64.
-- generation increments on each successful token refresh to detect races.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_connections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               TEXT    NOT NULL CHECK(provider IN ('google', 'microsoft')),
  provider_account_id    TEXT    NOT NULL,      -- provider's stable account identifier
  provider_email         TEXT,                  -- shown in UI; not used for auth decisions
  encrypted_refresh_token TEXT,                 -- AES-256-GCM; NULL when disconnected
  scopes                 TEXT    NOT NULL DEFAULT '', -- space-separated granted scopes
  generation             INTEGER NOT NULL DEFAULT 1,  -- incremented on each token rotation
  status                 TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'error')),
  connected_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)                     -- one active connection per user per provider
);

CREATE INDEX IF NOT EXISTS idx_oauth_connections_user    ON oauth_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_account ON oauth_connections(provider, provider_account_id);

-- ---------------------------------------------------------------------------
-- User-scoped key-value settings
-- Replaces the single-user global `settings` table for all user-owned keys.
-- Global/deployment settings remain in environment variables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);

-- ---------------------------------------------------------------------------
-- Security audit log (no secrets, no task content)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS security_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),      -- NULL for pre-auth events (e.g. brute-force)
  event_type TEXT    NOT NULL,                  -- see SecurityEventType in interfaces file
  ip_hint    TEXT,                              -- partial IP; not used as identity
  details    TEXT,                              -- JSON blob; no tokens, no task data
  created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_events_user    ON security_events(user_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type    ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);

-- ---------------------------------------------------------------------------
-- User-owned task data
-- The existing single-user tables are dropped and recreated with user_id.
-- task_plans and remote_* tables also gain user_id for strict ownership.
-- ---------------------------------------------------------------------------

-- Drop old single-user tables (only executed on a clean DB; migration path is
-- a separate reset command documented in ops docs).
-- On a fresh DB these do not exist, so IF EXISTS guards are sufficient.

DROP TABLE IF EXISTS tasks;
CREATE TABLE tasks (
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

-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS task_plans;
CREATE TABLE task_plans (
  -- Composite PK because the same remote task_key can belong to different users.
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_key             TEXT    NOT NULL,        -- 'local:<id>' or '<provider>:<account>:<list>:<id>'
  scheduled_at         TEXT,
  duration_minutes     INTEGER NOT NULL DEFAULT 30,
  schedule_version     INTEGER NOT NULL DEFAULT 0,
  legacy_schedule      INTEGER NOT NULL DEFAULT 0,
  mirror_requested     INTEGER NOT NULL DEFAULT 0,
  mirror_event_id      TEXT,
  mirror_account_id    TEXT,
  mirror_transaction_id TEXT,
  mirror_error         TEXT,
  mirror_create_payload TEXT,
  mirror_orphaned_at   TEXT,
  mirror_orphan_title  TEXT,
  project              TEXT,
  tags                 TEXT,
  energy               TEXT,
  local_priority       TEXT,
  UNIQUE(user_id, task_key)                     -- replaces old single-column UNIQUE on task_key
);

CREATE INDEX IF NOT EXISTS idx_task_plans_user    ON task_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_task_plans_mirror  ON task_plans(user_id, mirror_orphaned_at)
  WHERE mirror_orphaned_at IS NOT NULL;

-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS remote_tasks;
CREATE TABLE remote_tasks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_key  TEXT    NOT NULL,                   -- '<provider>:<account>:<list>:<id>'
  account_id TEXT   NOT NULL,
  list_id   TEXT    NOT NULL,
  task_json TEXT    NOT NULL,
  source    TEXT    NOT NULL DEFAULT 'microsoft',
  UNIQUE(user_id, task_key)                     -- scoped by owner
);

CREATE INDEX IF NOT EXISTS idx_remote_tasks_user    ON remote_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_tasks_account ON remote_tasks(user_id, account_id, source);

-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS remote_task_lists;
CREATE TABLE remote_task_lists (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_key  TEXT    NOT NULL,                   -- '<provider>:<account>:<list_id>'
  source    TEXT    NOT NULL,
  account_id TEXT   NOT NULL,
  list_json TEXT    NOT NULL,
  UNIQUE(user_id, list_key)                     -- scoped by owner
);

CREATE INDEX IF NOT EXISTS idx_remote_task_lists_user    ON remote_task_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_task_lists_account ON remote_task_lists(user_id, source, account_id);

-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS calendar_event_creates;
CREATE TABLE calendar_event_creates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  connection_id TEXT    NOT NULL,
  calendar_id   TEXT    NOT NULL,
  operation_id  TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- operation_id is unique per user + provider + account, not globally
  UNIQUE(user_id, provider, account_id, connection_id, calendar_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_creates_user ON calendar_event_creates(user_id);

-- ---------------------------------------------------------------------------
-- Global/deployment state (NOT user data)
-- The old single-user `settings` table is retired.  The only persistent
-- global key remaining is SETUP_TOKEN_USED, written once after first-admin
-- bootstrap and checked on every startup to block repeated setup.
-- All other deployment configuration lives in environment variables.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS settings;
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Only allowed global keys:
--   SETUP_TOKEN_USED      TEXT 'yes'  -- written once; blocks repeated admin setup
--   (add new global keys here with a comment explaining why they are global)
