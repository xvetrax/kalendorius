/**
 * Multi-user architecture contract — H0
 *
 * This file is documentation-as-code: it defines the TypeScript types,
 * row shapes, and function signatures that ALL subsequent implementation
 * phases (H1–H8) must conform to.  Nothing here is imported at runtime yet;
 * it becomes the real lib code in H1–H3.
 *
 * Rules (non-negotiable):
 *  1. UserContext is resolved ONLY from a server-verified DB session.
 *     It is NEVER constructed from a client-supplied userId parameter.
 *  2. Every DB query that touches user-owned data MUST receive UserContext
 *     and apply WHERE user_id = ctx.id in the SQL itself — never in JS.
 *  3. OAuth refresh tokens are stored AES-256-GCM encrypted in
 *     oauth_connections.encrypted_refresh_token, never in settings.
 *  4. Session raw tokens live only in HttpOnly cookies.
 *     token_hash = SHA-256(raw_token) is what gets stored in `sessions`.
 *  5. Invite and recovery raw tokens are delivered out-of-band.
 *     token_hash = SHA-256(raw_token) is what gets stored in `invites`.
 *  6. assertSameOrigin() is called on ALL mutating API routes.
 *  7. Admin role lets an admin manage users; it does NOT grant access to
 *     other users' tasks, calendar data, or OAuth tokens.
 *  8. timingSafeEqual is used for every token / password comparison.
 */

// ---------------------------------------------------------------------------
// Core identity
// ---------------------------------------------------------------------------

export type UserRole   = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

/** Resolved from a verified DB session; passed as the first param to every
 *  service function that reads or writes user-owned data. */
export interface UserContext {
  id:   number;
  role: UserRole;
}

/** Full row from the `users` table. */
export interface UserRow {
  id:            number;
  display_name:  string;
  primary_email: string;
  role:          UserRole;
  status:        UserStatus;
  created_at:    string;           // ISO-8601
  last_login_at: string | null;    // NULL until first login
}

/** Row from `auth_identities`. */
export interface AuthIdentityRow {
  id:            number;
  user_id:       number;
  provider:      'google' | 'microsoft';
  issuer:        string;           // verified OIDC issuer URL
  subject:       string;           // verified OIDC sub claim
  display_email: string | null;    // informational only; not used for auth
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Row from `sessions`. */
export interface SessionRow {
  id:           number;
  token_hash:   string;            // SHA-256(raw cookie token) hex
  user_id:      number;
  expires_at:   string;            // ISO-8601
  last_used_at: string;            // ISO-8601
  revoked_at:   string | null;     // NULL = still active
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** Row from `invites`. */
export interface InviteRow {
  id:              number;
  token_hash:      string;         // SHA-256(raw invite token) hex
  recipient_email: string | null;  // hint only; not enforced during use
  role:            UserRole;
  created_by:      number;         // users.id of the admin who created it
  expires_at:      string;         // ISO-8601
  used_at:         string | null;
  used_by:         number | null;  // users.id of who consumed it
}

// ---------------------------------------------------------------------------
// Auth operations (short-lived OIDC / PKCE flows)
// ---------------------------------------------------------------------------

/** Row from `auth_operations`. */
export interface AuthOperationRow {
  id:            number;
  state_hash:    string;           // SHA-256(OAuth state param) hex
  nonce:         string;           // OIDC nonce verified in id_token
  pkce_verifier: string;           // stored server-side; never sent to client
  provider:      'google' | 'microsoft';
  invite_id:     number | null;    // set when initiated via an invite link
  session_id:    number | null;    // set when initiated by a logged-in user
  callback_path: string;           // e.g. '/api/google/callback'
  expires_at:    string;           // ISO-8601; short-lived (≤10 min)
  used:          0 | 1;           // 1 once callback processed; blocks replay
}

// ---------------------------------------------------------------------------
// OAuth connections (Calendar / Tasks; separate from login identity)
// ---------------------------------------------------------------------------

export type OAuthProvider     = 'google' | 'microsoft';
export type OAuthConnectionStatus = 'active' | 'revoked' | 'error';

/** Row from `oauth_connections`. */
export interface OAuthConnectionRow {
  id:                      number;
  user_id:                 number;
  provider:                OAuthProvider;
  provider_account_id:     string;         // stable ID from the provider
  provider_email:          string | null;  // displayed in UI; NOT used for auth
  encrypted_refresh_token: string | null;  // AES-256-GCM base64; NULL when disconnected
  scopes:                  string;         // space-separated granted scopes
  generation:              number;         // incremented on each token rotation
  status:                  OAuthConnectionStatus;
  connected_at:            string;         // ISO-8601
}

// ---------------------------------------------------------------------------
// Security events
// ---------------------------------------------------------------------------

export type SecurityEventType =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'logout_all'
  | 'session_expired'
  | 'invite_created'
  | 'invite_used'
  | 'invite_expired'
  | 'account_recovery_created'
  | 'account_recovery_used'
  | 'oauth_connected'
  | 'oauth_disconnected'
  | 'oauth_token_refresh_error'
  | 'account_disabled'
  | 'account_enabled'
  | 'account_deleted'
  | 'identity_linked'
  | 'identity_unlinked'
  | 'setup_complete'
  | 'admin_action';

/** Row from `security_events`. */
export interface SecurityEventRow {
  id:         number;
  user_id:    number | null;  // NULL for pre-auth events (e.g. brute-force probes)
  event_type: SecurityEventType;
  ip_hint:    string | null;  // partial IP; used as signal only, never as identity
  details:    string | null;  // JSON; MUST NOT contain tokens, passwords, or task content
  created_at: string;         // ISO-8601
}

// ---------------------------------------------------------------------------
// User settings
// ---------------------------------------------------------------------------

/**
 * Setting keys that remain GLOBAL (stored in the `settings` table or env vars).
 * These have exactly one value for the entire deployment.
 */
export const GLOBAL_SETTING_KEYS = [
  /**
   * Written once after first-admin bootstrap; checked on startup to block
   * repeated setup even if SETUP_TOKEN env var is still present.
   */
  'SETUP_TOKEN_USED',
] as const;

export type GlobalSettingKey = typeof GLOBAL_SETTING_KEYS[number];

/**
 * Setting keys that are USER-SCOPED (stored in `user_settings` with user_id).
 * The same key for two different users stores independent values.
 *
 * Migrated from the old single-user `settings` table:
 *  - google_*  → per-user in user_settings (connection state now in oauth_connections)
 *  - microsoft_* → per-user in user_settings (connection state now in oauth_connections)
 *  - planner-theme, planner-panel-collapsed → per-user UI preferences
 *  - task_move_pending:* → per-user transient state (keyed by operation hash)
 *  - migration_task_plans_v1 → retired; new schema has no single-user migrations
 *
 * Calendar / Tasks integration state (previously global settings):
 */
export const USER_SETTING_KEYS = [
  // Google Calendar
  'google_calendars',             // JSON: selected calendar IDs and their colours
  'google_calendar_selection',    // JSON: which calendars are visible
  // Google Tasks
  'google_task_lists',            // JSON: fetched task list metadata
  'google_active_task_list',      // string: currently selected list ID
  // Microsoft Calendar
  'microsoft_calendars',          // JSON: selected calendar IDs
  'microsoft_calendar_selection', // JSON: which calendars are visible
  'microsoft_default_calendar_identity', // string: default calendar identity key
  // Microsoft To Do
  'microsoft_task_list_id',       // string: cached default task list ID
  'microsoft_task_lists',         // JSON: fetched task list metadata
  // UI preferences
  'planner-theme',                // string: light | dark | system
  'planner-panel-collapsed',      // string: '0' | '1'
  // Transient per-user operation state (prefixed)
  // 'task_move_pending:<sha256>'  — stored transiently; prefix is the key pattern
] as const;

export type UserSettingKey = typeof USER_SETTING_KEYS[number];

// ---------------------------------------------------------------------------
// Service-layer function signatures (to be implemented in H1–H3)
// ---------------------------------------------------------------------------

/**
 * requireUser — resolves the current user from the HTTP request's session cookie.
 *
 * Implementation contract (H2):
 *  1. Read the session cookie (SESSION_COOKIE name = 'planner_session').
 *  2. Hash the raw token with SHA-256 to get token_hash.
 *  3. Look up the sessions row WHERE token_hash = ? AND revoked_at IS NULL
 *     AND expires_at > CURRENT_TIMESTAMP.
 *  4. If no row: throw a 401 Response (or an error with status 401).
 *  5. UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = <row.id>.
 *  6. Load the users row WHERE id = sessions.user_id AND status = 'active'.
 *  7. If user is disabled or missing: revoke the session and throw 401.
 *  8. Return { id: user.id, role: user.role }.
 *
 * NEVER accept a userId from the request body, query string, or headers.
 */
export declare function requireUser(request: Request): Promise<UserContext>;

/**
 * requireAdmin — same as requireUser but additionally asserts role = 'admin'.
 * Throws a 403 Response if the resolved user is not an admin.
 */
export declare function requireAdmin(request: Request): Promise<UserContext>;

/**
 * logSecurityEvent — appends a row to security_events.
 * Must not throw; if the insert fails it should log to stderr and continue.
 * Never pass tokens, passwords, or task content in `details`.
 */
export declare function logSecurityEvent(
  db:        import('node:sqlite').DatabaseSync,
  eventType: SecurityEventType,
  opts?: {
    userId?:  number;
    ipHint?:  string;
    details?: Record<string, unknown>;
  }
): void;

// ---------------------------------------------------------------------------
// OAuthConnectionContext — passed to provider adapters instead of globals
// ---------------------------------------------------------------------------

/**
 * Replaces the current implicit "single active account" pattern.
 * Every Google / Microsoft API call receives this context, enabling
 * per-user token isolation and concurrent multi-user operation.
 */
export interface OAuthConnectionContext {
  /** oauth_connections.id */
  connectionDbId:      number;
  /** users.id — owner of this connection */
  userId:              number;
  /** Provider stable account ID (e.g. Google sub or Microsoft account ID) */
  providerAccountId:   string;
  /** Current connection generation; used to detect stale cached tokens */
  generation:          number;
  /** Granted scopes (space-separated) */
  scopes:              string;
}

// ---------------------------------------------------------------------------
// First-admin bootstrap contract (H1)
// ---------------------------------------------------------------------------

/**
 * isSetupAllowed — returns true only when:
 *  1. The `users` table is empty (no admin exists yet).
 *  2. The global setting SETUP_TOKEN_USED has NOT been written.
 *  3. process.env.SETUP_TOKEN is set and non-empty.
 *
 * Once a first admin is created, SETUP_TOKEN_USED is written atomically
 * and this function returns false for all future calls — even if the env
 * var is still present.
 */
export declare function isSetupAllowed(
  db: import('node:sqlite').DatabaseSync
): boolean;

/**
 * claimSetupToken — timing-safe comparison of the provided token against
 * process.env.SETUP_TOKEN.  Returns true only if they match AND setup is
 * still allowed.  Never logs the raw token.
 */
export declare function claimSetupToken(
  db:       import('node:sqlite').DatabaseSync,
  provided: string
): boolean;
