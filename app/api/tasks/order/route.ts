import { apiError, assertSameOrigin } from "@/lib/http";
import { TaskError } from "@/lib/task-service";
import { taskServiceForRequest } from "@/lib/task-request-service";

export const runtime = "nodejs";

const getTaskService = taskServiceForRequest;

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
