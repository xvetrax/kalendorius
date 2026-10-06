import { db, requireUserContext } from "@/lib/db-multi";
import { listConnections } from "@/lib/oauth-service";
import {
  makeGoogleTaskGatewayForConnection,
  makeMicrosoftTaskGatewayForConnection,
} from "@/lib/task-gateway";
import { createTaskService } from "@/lib/task-service";
import { createTaskStartNotificationHooks } from "@/lib/notification-jobs";

/** Builds one account-bound gateway per active integration for every task route. */
export function taskServiceForRequest(request: Request) {
  const user = requireUserContext(request);
  const microsoft = listConnections(user.id, "microsoft")
    .filter((connection) => connection.status === "active")
    .map((connection) => makeMicrosoftTaskGatewayForConnection(user.id, connection));
  const google = listConnections(user.id, "google")
    .filter((connection) => connection.status === "active")
    .map((connection) => makeGoogleTaskGatewayForConnection(user.id, connection));
  return createTaskService(db, user.id, microsoft, google, createTaskStartNotificationHooks(db, user.id));
}
