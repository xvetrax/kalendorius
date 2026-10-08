import { TaskError } from "@/lib/task-service";
import { apiError, assertSameOrigin } from "@/lib/http";
import { taskServiceForRequest } from "@/lib/task-request-service";

export const runtime = "nodejs";

const getTaskService = taskServiceForRequest;

function failure(error: unknown) {
  if (error instanceof TaskError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Response) return error;
  return apiError(error);
}

async function input(request: Request) {
  assertSameOrigin(request);
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TaskError("Neteisingi sąrašo duomenys.");
  return value as Record<string, unknown>;
}

export async function GET(request: Request) {
  try {
    const tasks = getTaskService(request);
    const params = new URL(request.url).searchParams;
    const result = params.has("list_id")
      ? await tasks.previewListDeletion(Object.fromEntries(params))
      : await tasks.listCatalog();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const tasks = getTaskService(request);
    return Response.json(await tasks.createList(await input(request)), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const tasks = getTaskService(request);
    return Response.json(await tasks.renameList(await input(request)));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const tasks = getTaskService(request);
    await tasks.deleteList(await input(request));
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
