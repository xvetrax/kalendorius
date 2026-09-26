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
import { getConnection } from "@/lib/oauth-service";
import type { TaskGateway } from "@/lib/task-service";

/**
 * makeMicrosoftTaskGateway — creates a TaskGateway for Microsoft To Do
 * scoped to the given userId. All requests use the per-user oauth_connection.
 */
export function makeMicrosoftTaskGateway(userId: number): TaskGateway {
  return {
    connected: () => isMicrosoftConnectedForUser(userId),
    cachedAccountId: () => microsoftAccountIdForUser(userId),
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
