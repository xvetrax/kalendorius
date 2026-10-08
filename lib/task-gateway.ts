/**
 * lib/task-gateway.ts — Per-user TaskGateway factory (H4)
 *
 * Creates per-user Microsoft/Google gateways for task-service routes.
 * All token access is scoped to the authenticated user's oauth_connections row.
 */

import {
  isMicrosoftConnectedForUser,
  microsoftAccountIdForUser,
  graphFetchForUser,
  defaultTaskListIdForUser,
} from "@/lib/microsoft";
import {
  isGoogleTasksConnectedForUser,
  googleAccountIdForUser,
  googleTasksFetchForUser,
} from "@/lib/google";
import { getConnection, getConnectionById, listConnections } from "@/lib/oauth-service";
import type { OAuthConnectionRow } from "@/lib/oauth-service";
import type { TaskGateway } from "@/lib/task-service";

const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/**
 * makeMicrosoftTaskGateway — creates a TaskGateway for Microsoft To Do
 * scoped to the given userId. All requests use the per-user oauth_connection.
 */
export function makeMicrosoftTaskGateway(userId: number): TaskGateway {
  return {
    connected: () => isMicrosoftConnectedForUser(userId),
    cachedAccountId: () => microsoftAccountIdForUser(userId),
    connectionId: () => getConnection(userId, "microsoft")?.id ?? null,
    accountId: async () => {
      const id = microsoftAccountIdForUser(userId);
      if (!id) throw new Error("Microsoft neprijungtas");
      return id;
    },
    defaultListId: async () => {
      const conn = getConnection(userId, "microsoft");
      if (!conn) throw new Error("Microsoft neprijungtas");
      return defaultTaskListIdForUser(userId, conn);
    },
    request: (path: string, init?: RequestInit) => {
      const conn = getConnection(userId, "microsoft");
      if (!conn) throw new Error("Microsoft neprijungtas");
      return graphFetchForUser(userId, conn, path, init);
    },
  };
}

/**
 * makeGoogleTaskGateway — creates a TaskGateway for Google Tasks
 * scoped to the given userId.
 */
export function makeGoogleTaskGateway(userId: number): TaskGateway {
  return {
    connected: () => isGoogleTasksConnectedForUser(userId),
    cachedAccountId: () => googleAccountIdForUser(userId),
    connectionId: () => getConnection(userId, "google")?.id ?? null,
    accountId: async () => {
      const id = googleAccountIdForUser(userId);
      if (!id || !isGoogleTasksConnectedForUser(userId))
        throw new Error("Google paskyra neprijungta");
      return id;
    },
    request: (path: string, init?: RequestInit) => {
      const conn = getConnection(userId, "google");
      if (!conn) throw new Error("Google Tasks neprijungta");
      return googleTasksFetchForUser(userId, conn, path, init);
    },
  };
}

/**
 * makeMicrosoftTaskGatewayForConnection — creates a TaskGateway for Microsoft To Do
 * scoped to a specific oauth_connections row.
 */
export function makeMicrosoftTaskGatewayForConnection(userId: number, conn: OAuthConnectionRow): TaskGateway {
  return {
    connected: () => {
      const c = getConnectionById(userId, conn.id, "microsoft");
      return Boolean(c && c.status === "active" && c.encrypted_refresh_token);
    },
    cachedAccountId: () => {
      const current = getConnectionById(userId, conn.id, "microsoft");
      return current?.status === "active" ? current.provider_account_id : null;
    },
    connectionId: () => conn.id,
    label: () => {
      const current = getConnectionById(userId, conn.id, "microsoft");
      return current?.provider_email || current?.provider_account_id || conn.provider_email || conn.provider_account_id;
    },
    accountId: async () => {
      const c = getConnectionById(userId, conn.id, "microsoft");
      if (!c || c.status !== "active") throw new Error("Microsoft neprijungtas");
      return c.provider_account_id;
    },
    defaultListId: async () => {
      const c = getConnectionById(userId, conn.id, "microsoft");
      if (!c) throw new Error("Microsoft neprijungtas");
      return defaultTaskListIdForUser(userId, c);
    },
    request: (path: string, init?: RequestInit) => {
      const c = getConnectionById(userId, conn.id, "microsoft");
      if (!c) throw new Error("Microsoft neprijungtas");
      return graphFetchForUser(userId, c, path, init);
    },
  };
}

/**
 * makeGoogleTaskGatewayForConnection — creates a TaskGateway for Google Tasks
 * scoped to a specific oauth_connections row.
 */
export function makeGoogleTaskGatewayForConnection(userId: number, conn: OAuthConnectionRow): TaskGateway {
  return {
    connected: () => {
      const c = getConnectionById(userId, conn.id, "google");
      if (!c || c.status !== "active" || !c.encrypted_refresh_token) return false;
      return (c.scopes ?? "").split(" ").includes(TASKS_SCOPE);
    },
    cachedAccountId: () => {
      const current = getConnectionById(userId, conn.id, "google");
      return current?.status === "active" ? current.provider_account_id : null;
    },
    connectionId: () => conn.id,
    label: () => {
      const current = getConnectionById(userId, conn.id, "google");
      return current?.provider_email || current?.provider_account_id || conn.provider_email || conn.provider_account_id;
    },
    accountId: async () => {
      const current = getConnectionById(userId, conn.id, "google");
      if (!current || current.status !== "active") throw new Error("Google Tasks neprijungta");
      return current.provider_account_id;
    },
    request: (path: string, init?: RequestInit) => {
      const c = getConnectionById(userId, conn.id, "google");
      if (!c) throw new Error("Google Tasks neprijungta");
      return googleTasksFetchForUser(userId, c, path, init);
    },
  };
}
