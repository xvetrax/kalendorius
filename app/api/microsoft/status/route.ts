import {
  disconnectMicrosoftForUser,
  isMicrosoftConfigured,
} from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { requireUserContext } from "@/lib/db-multi";
import { listConnections } from "@/lib/oauth-service";

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    const connections = listConnections(user.id, "microsoft").map((connection) => ({
      id: connection.id,
      accountId: connection.provider_account_id,
      email: connection.provider_email,
      label: connection.display_label,
      colorKey: connection.color_key,
      status: connection.status,
      connectedAt: connection.connected_at,
      calendarConnected: connection.status === "active",
      tasksConnected:
        connection.status === "active" && connection.scopes.split(/\s+/).includes("Tasks.ReadWrite"),
    }));
    const active = connections.filter((connection) => connection.status === "active");
    const sole = active.length === 1 ? active[0] : null;
    return Response.json(
      {
        connected: active.length > 0,
        configured: isMicrosoftConfigured(),
        account: sole?.email ?? null,
        connections,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const rawConnectionId = new URL(request.url).searchParams.get("connectionId");
    const connectionId = rawConnectionId === null ? undefined : Number(rawConnectionId);
    if (connectionId !== undefined && (!Number.isSafeInteger(connectionId) || connectionId <= 0)) {
      return Response.json({ error: "Neteisingas jungties ID." }, { status: 400 });
    }
    const disconnected = disconnectMicrosoftForUser(user.id, connectionId);
    if (!disconnected) {
      return Response.json({ error: "Microsoft jungtis nerasta." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}
