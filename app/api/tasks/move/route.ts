import { db, requireUserContext } from "@/lib/db-multi";
import { apiError, assertSameOrigin } from "@/lib/http";
import { createTaskService, TaskError } from "@/lib/task-service";
import { makeMicrosoftTaskGateway, makeGoogleTaskGateway } from "@/lib/task-gateway";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const tasks = createTaskService(db, user.id, makeMicrosoftTaskGateway(user.id), makeGoogleTaskGateway(user.id));
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
