import { db, requireUserContext } from "@/lib/db-multi";
import { apiError, assertSameOrigin } from "@/lib/http";
import { createTaskService, TaskError } from "@/lib/task-service";
import { makeMicrosoftTaskGatewayForConnection, makeGoogleTaskGatewayForConnection } from "@/lib/task-gateway";
import { listConnections } from "@/lib/oauth-service";

export const runtime = "nodejs";

function getTaskService(request: Request) {
  const user = requireUserContext(request);
  const msConns = listConnections(user.id, "microsoft").filter(c => c.status === "active");
  const gConns = listConnections(user.id, "google").filter(c => c.status === "active");
  return createTaskService(
    db, user.id,
    msConns.map(conn => makeMicrosoftTaskGatewayForConnection(user.id, conn)),
    gConns.map(conn => makeGoogleTaskGatewayForConnection(user.id, conn)),
  );
}

function failure(error: unknown) {
  if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  if (error instanceof Response) return error;
  return apiError(error);
}
async function input(request: Request) {
  assertSameOrigin(request);
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi užklausos duomenys.");
  return body as Record<string, unknown>;
}
export async function GET(request: Request) {
  try {
    const tasks = getTaskService(request);
    const result = await tasks.list();
    return Response.json(new URL(request.url).searchParams.get("envelope") === "1" ? result : result.items, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const tasks = getTaskService(request);
    return Response.json(await tasks.create(await input(request)), { status: 201 });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const tasks = getTaskService(request);
    return Response.json(await tasks.update(await input(request)));
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const tasks = getTaskService(request);
    await tasks.remove(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}
