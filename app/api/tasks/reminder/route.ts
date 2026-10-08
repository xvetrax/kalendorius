import { TaskError } from "@/lib/task-service";
import { apiError, assertSameOrigin } from "@/lib/http";
import { taskServiceForRequest } from "@/lib/task-request-service";

export const runtime = "nodejs";

const getTaskService = taskServiceForRequest;

function failure(error: unknown) {
  if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && "status" in error && error.status === 412)
    return Response.json({ error: "Microsoft priminimas jau pakeistas. Atnaujink priminimą ir patikrink laiką." }, { status: 409 });
  if (error instanceof Response) return error;
  return apiError(error);
}

export async function GET(request: Request) {
  try {
    return Response.json(await getTaskService(request).readReminder(Object.fromEntries(new URL(request.url).searchParams)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi priminimo duomenys.");
    return Response.json(await getTaskService(request).updateReminder(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
