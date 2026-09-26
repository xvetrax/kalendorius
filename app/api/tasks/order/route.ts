import { db, requireUserContext } from "@/lib/db-multi";
import { apiError, assertSameOrigin } from "@/lib/http";
import { createTaskService, TaskError } from "@/lib/task-service";
import { makeMicrosoftTaskGateway, makeGoogleTaskGateway } from "@/lib/task-gateway";

export const runtime = "nodejs";

function getTaskService(request: Request) {
  const user = requireUserContext(request);
  return createTaskService(db, user.id, makeMicrosoftTaskGateway(user.id), makeGoogleTaskGateway(user.id));
}

function failure(error: unknown) {
  if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "Neteisingi Google hierarchijos duomenys." }, { status: 400 });
  if (error instanceof Response) return error;
  return apiError(error);
}
async function input(request: Request) {
  assertSameOrigin(request);
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi Google hierarchijos duomenys.");
  return body as Record<string, unknown>;
}
export async function GET(request: Request) {
  try {
    return Response.json(await getTaskService(request).readGoogleOrder(Object.fromEntries(new URL(request.url).searchParams)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    return Response.json(await getTaskService(request).updateGoogleOrder(await input(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
