import { apiError, assertSameOrigin } from "@/lib/http";
import { TaskError } from "@/lib/task-service";
import { taskServiceForRequest } from "@/lib/task-request-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const tasks = taskServiceForRequest(request);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskError("Neteisingi užklausos duomenys.");
    return Response.json(await tasks.moveGoogle(body as Record<string, unknown>));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
    return apiError(error);
  }
}
