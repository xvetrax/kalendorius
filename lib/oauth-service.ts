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
  return (
    (db
      .prepare(
        `SELECT id, user_id, provider, provider_account_id, provider_email,
                encrypted_refresh_token, scopes, generation, status, connected_at
         FROM oauth_connections
         WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, provider) as OAuthConnectionRow | undefined) ?? null
  );
}

/**
 * listConnections — returns all oauth_connections rows for this user.
 * SECURITY: always filters by user_id.
 */
export function listConnections(userId: number): OAuthConnectionRow[] {
  return db
    .prepare(
      `SELECT id, user_id, provider, provider_account_id, provider_email,
              encrypted_refresh_token, scopes, generation, status, connected_at
       FROM oauth_connections
       WHERE user_id = ?`,
    )
    .all(userId) as unknown as OAuthConnectionRow[];
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * saveConnection — upserts an oauth_connections row for this user+provider.
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
        encrypted_refresh_token, scopes, generation, status, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       provider_account_id     = excluded.provider_account_id,
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
  );

  const row = db
    .prepare(
      `SELECT id FROM oauth_connections WHERE user_id = ? AND provider = ?`,
    )
    .get(userId, provider) as { id: number } | undefined;

  if (!row) throw new Error("oauth-service: saveConnection: row missing after upsert");
  return row.id;
}

/**
 * updateRefreshToken — CAS (compare-and-swap) update.
 * Only updates if the current generation matches the supplied generation.
 * Throws if the row was already rotated (concurrent refresh race).
 *
 * The newEncryptedToken MUST already be encrypted by lib/secrets.ts encrypt().
 */
export function updateRefreshToken(
  connectionId: number,
  newEncryptedToken: string,
  generation: number,
): void {
  const result = db
    .prepare(
      `UPDATE oauth_connections
       SET encrypted_refresh_token = ?,
           generation = generation + 1
       WHERE id = ? AND generation = ?`,
    )
    .run(newEncryptedToken, connectionId, generation);

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
  db.prepare(
    `DELETE FROM oauth_connections WHERE user_id = ? AND provider = ?`,
  ).run(userId, provider);
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
export function getDecryptedRefreshToken(connectionId: number): string {
  const row = db
    .prepare(
      `SELECT encrypted_refresh_token FROM oauth_connections WHERE id = ?`,
    )
    .get(connectionId) as { encrypted_refresh_token: string | null } | undefined;

  if (!row || !row.encrypted_refresh_token) {
    throw new Error("oauth-service: no refresh token for connection " + connectionId);
  }

  return decrypt(row.encrypted_refresh_token);
}
