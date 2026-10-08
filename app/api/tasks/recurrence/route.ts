import { apiError, assertSameOrigin } from "@/lib/http";
import { TaskError } from "@/lib/task-service";
import { taskServiceForRequest } from "@/lib/task-request-service";

export const runtime = "nodejs";

const getTaskService = taskServiceForRequest;

function failure(error: unknown) {
  if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && "status" in error && error.status === 412)
    return Response.json({ error: "Microsoft kartojimo taisyklė jau pakeista. Atnaujink kartojimą." }, { status: 409 });
  if (error instanceof Response) return error;
  return apiError(error);
}

export async function GET(request: Request) {
  try {
    return Response.json(await getTaskService(request).readRecurrence(Object.fromEntries(new URL(request.url).searchParams)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi kartojimo duomenys.");
    return Response.json(await getTaskService(request).updateRecurrence(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
