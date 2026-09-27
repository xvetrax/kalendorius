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
    used          INTEGER NOT NULL DEFAULT 0
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
    UNIQUE(user_id, provider)
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
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "planner_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

  // Touch last_used_at
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(nowIso(), session.id);

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
