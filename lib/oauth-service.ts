/**
 * lib/oauth-service.ts — Per-user OAuth connection management (H4)
 *
 * Security constraints (non-negotiable):
 *  1. User identity resolved ONLY from server-verified DB session.
 *  2. Every DB operation requires userId param — no query without owner filter.
 *  3. OAuth refresh tokens stored AES-256-GCM encrypted (via lib/secrets.ts).
 *  6. All token comparisons use timingSafeEqual.
 *  7. Admin role does NOT grant access to other users' OAuth tokens.
 */

import { db } from "@/lib/db-multi";
import { decrypt } from "@/lib/secrets";

// ---------------------------------------------------------------------------
// Types (matching multi-user-interfaces.ts contract)
// ---------------------------------------------------------------------------

export type OAuthProvider = "google" | "microsoft";
export type OAuthConnectionStatus = "active" | "revoked" | "error";
export type OAuthConnectMode = "legacy" | "add" | "reconsent";

export interface OAuthConnectionRow {
  id:                      number;
  user_id:                 number;
  provider:                OAuthProvider;
  provider_account_id:     string;
  provider_email:          string | null;
  encrypted_refresh_token: string | null;
  scopes:                  string;
  generation:              number;
  status:                  OAuthConnectionStatus;
  connected_at:            string;
  display_label:           string | null;
  color_key:               string;
}

export class AmbiguousOAuthConnectionError extends Error {
  constructor(provider: OAuthProvider) {
    super(`oauth-service: multiple active ${provider} connections require an explicit connection id`);
    this.name = "AmbiguousOAuthConnectionError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * getConnection — returns the active oauth_connections row for this user+provider.
 * Returns null if no connection exists or if it is revoked.
 * SECURITY: always filters by user_id — never returns another user's connection.
 */
export function getConnection(
  userId: number,
  provider: OAuthProvider,
): OAuthConnectionRow | null {
  const rows = db
    .prepare(
      `SELECT id, user_id, provider, provider_account_id, provider_email,
              encrypted_refresh_token, scopes, generation, status, connected_at,
              display_label, color_key
       FROM oauth_connections
       WHERE user_id = ? AND provider = ? AND status = 'active'
       ORDER BY id
       LIMIT 2`,
    )
    .all(userId, provider) as unknown as OAuthConnectionRow[];
  if (rows.length > 1) throw new AmbiguousOAuthConnectionError(provider);
  return rows[0] ?? null;
}

/** Returns one user-owned connection by its internal id. */
export function getConnectionById(
  userId: number,
  connectionId: number,
  provider?: OAuthProvider,
): OAuthConnectionRow | null {
  const providerClause = provider ? " AND provider = ?" : "";
  const values = provider ? [userId, connectionId, provider] : [userId, connectionId];
  return (
    db.prepare(
      `SELECT id, user_id, provider, provider_account_id, provider_email,
              encrypted_refresh_token, scopes, generation, status, connected_at,
              display_label, color_key
       FROM oauth_connections
       WHERE user_id = ? AND id = ?${providerClause}`,
    ).get(...values) as OAuthConnectionRow | undefined
  ) ?? null;
}

/** Returns a user-owned connection for an exact provider account. */
export function getConnectionByAccount(
  userId: number,
  provider: OAuthProvider,
  providerAccountId: string,
): OAuthConnectionRow | null {
  return (
    db.prepare(
      `SELECT id, user_id, provider, provider_account_id, provider_email,
              encrypted_refresh_token, scopes, generation, status, connected_at,
              display_label, color_key
       FROM oauth_connections
       WHERE user_id = ? AND provider = ? AND provider_account_id = ?`,
    ).get(userId, provider, providerAccountId) as OAuthConnectionRow | undefined
  ) ?? null;
}

/**
 * listConnections — returns all oauth_connections rows for this user.
 * SECURITY: always filters by user_id.
 */
export function listConnections(userId: number, provider?: OAuthProvider): OAuthConnectionRow[] {
  const providerClause = provider ? " AND provider = ?" : "";
  const values = provider ? [userId, provider] : [userId];
  return db.prepare(
    `SELECT id, user_id, provider, provider_account_id, provider_email,
            encrypted_refresh_token, scopes, generation, status, connected_at,
            display_label, color_key
     FROM oauth_connections
     WHERE user_id = ?${providerClause}
     ORDER BY provider, id`,
  ).all(...values) as unknown as OAuthConnectionRow[];
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * saveConnection — upserts the exact user+provider+provider-account row.
 * The encryptedRefreshToken MUST already be encrypted by lib/secrets.ts encrypt()
 * before being passed here.
 *
 * Returns the connection id (new or existing).
 */
export function saveConnection(
  userId: number,
  provider: OAuthProvider,
  providerAccountId: string,
  providerEmail: string | null,
  encryptedRefreshToken: string,
  scopes: string,
): number {
  db.prepare(
    `INSERT INTO oauth_connections
      (user_id, provider, provider_account_id, provider_email,
        encrypted_refresh_token, scopes, generation, status, connected_at, color_key)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)
     ON CONFLICT(user_id, provider, provider_account_id) DO UPDATE SET
       provider_email          = excluded.provider_email,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       scopes                  = excluded.scopes,
       generation              = generation + 1,
       status                  = 'active',
       connected_at            = excluded.connected_at`,
  ).run(
    userId,
    provider,
    providerAccountId,
    providerEmail,
    encryptedRefreshToken,
    scopes,
    nowIso(),
    `${provider}:${providerAccountId}`,
  );

  const row = db
    .prepare(
      `SELECT id FROM oauth_connections
       WHERE user_id = ? AND provider = ? AND provider_account_id = ?`,
    )
    .get(userId, provider, providerAccountId) as { id: number } | undefined;

  if (!row) throw new Error("oauth-service: saveConnection: row missing after upsert");
  return row.id;
}

/**
 * Completes a data-OAuth callback under one SQLite write lock. The operation
 * mode is server-persisted; this function rechecks its invariant at the same
 * time as the write so another app process cannot change the decision.
 */
export function saveConnectionForOAuthOperation(
  userId: number,
  provider: OAuthProvider,
  providerAccountId: string,
  providerEmail: string | null,
  encryptedRefreshToken: string,
  scopes: string,
  mode: OAuthConnectMode,
  expectedConnectionId?: number | null,
): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    let connectionId: number;
    if (mode === "reconsent") {
      if (!expectedConnectionId) {
        throw new Error("oauth-service: re-consent requires an exact connection");
      }
      const result = db.prepare(
        `UPDATE oauth_connections
         SET provider_email = ?,
             encrypted_refresh_token = ?,
             scopes = ?,
             generation = generation + 1,
             status = 'active',
             connected_at = ?
         WHERE id = ? AND user_id = ? AND provider = ?
           AND provider_account_id = ? AND status = 'active'`,
      ).run(
        providerEmail,
        encryptedRefreshToken,
        scopes,
        nowIso(),
        expectedConnectionId,
        userId,
        provider,
        providerAccountId,
      );
      if (result.changes !== 1) {
        throw new Error("oauth-service: re-consent target changed or was disconnected");
      }
      connectionId = expectedConnectionId;
    } else {
      if (mode === "legacy") {
        const active = db.prepare(
          `SELECT id, provider_account_id
           FROM oauth_connections
           WHERE user_id = ? AND provider = ? AND status = 'active'
           ORDER BY id LIMIT 2`,
        ).all(userId, provider) as { id: number; provider_account_id: string }[];
        if (active.length > 1) throw new AmbiguousOAuthConnectionError(provider);
        if (active[0] && active[0].provider_account_id !== providerAccountId) {
          throw new Error("oauth-service: legacy callback selected another account");
        }
      }
      connectionId = saveConnection(
        userId,
        provider,
        providerAccountId,
        providerEmail,
        encryptedRefreshToken,
        scopes,
      );
    }
    db.exec("COMMIT");
    return connectionId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * updateRefreshToken — CAS (compare-and-swap) update.
 * Only updates if the current generation matches the supplied generation.
 * Throws if the row was already rotated (concurrent refresh race).
 *
 * The newEncryptedToken MUST already be encrypted by lib/secrets.ts encrypt().
 */
export function updateRefreshToken(
  userId: number,
  connectionId: number,
  provider: OAuthProvider,
  newEncryptedToken: string,
  generation: number,
): void {
  const result = db
    .prepare(
      `UPDATE oauth_connections
       SET encrypted_refresh_token = ?,
           generation = generation + 1
       WHERE id = ? AND user_id = ? AND provider = ? AND generation = ?`,
    )
    .run(newEncryptedToken, connectionId, userId, provider, generation);

  if (result.changes === 0) {
    throw new Error(
      "oauth-service: updateRefreshToken: generation mismatch — concurrent refresh race detected",
    );
  }
}

/**
 * deleteConnection — removes this user's connection (and cascades to cached data).
 * SECURITY: always filters by user_id so a user cannot delete another user's connection.
 */
export function deleteConnection(userId: number, provider: OAuthProvider): void {
  const rows = db.prepare(
    "SELECT id FROM oauth_connections WHERE user_id = ? AND provider = ? LIMIT 2",
  ).all(userId, provider) as { id: number }[];
  if (rows.length > 1) throw new AmbiguousOAuthConnectionError(provider);
  if (rows[0]) disconnectConnection(userId, rows[0].id, provider);
}

/** Deletes exactly one user-owned connection. Returns false when it did not exist. */
export function disconnectConnection(
  userId: number,
  connectionId: number,
  provider?: OAuthProvider,
): boolean {
  const providerClause = provider ? " AND provider = ?" : "";
  const values = provider ? [userId, connectionId, provider] : [userId, connectionId];
  const result = db.prepare(
    `DELETE FROM oauth_connections WHERE user_id = ? AND id = ?${providerClause}`,
  ).run(...values);
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Token decryption
// ---------------------------------------------------------------------------

/**
 * getDecryptedRefreshToken — fetches and decrypts the refresh token for a
 * specific connection row. Throws if the connection has no token.
 *
 * NOTE: the connectionId must belong to the authenticated user — callers are
 * responsible for verifying ownership before calling this function.
 */
export function getDecryptedRefreshToken(
  userId: number,
  connectionId: number,
  provider: OAuthProvider,
): string {
  const row = db
    .prepare(
      `SELECT encrypted_refresh_token FROM oauth_connections
       WHERE id = ? AND user_id = ? AND provider = ?`,
    )
    .get(connectionId, userId, provider) as { encrypted_refresh_token: string | null } | undefined;

  if (!row || !row.encrypted_refresh_token) {
    throw new Error("oauth-service: no refresh token for connection " + connectionId);
  }

  return decrypt(row.encrypted_refresh_token);
}
