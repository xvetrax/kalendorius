import { graphFetch, isMicrosoftConnected } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";

export const runtime = "nodejs";

function taskPath(listId: string, taskId: string) {
  return `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems`;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const listId = params.get("listId"), taskId = params.get("taskId");
  if (!listId || !taskId) return Response.json({ error: "Trūksta parametrų." }, { status: 400 });
  if (!isMicrosoftConnected()) return Response.json({ items: [] });
  try {
    const data = await graphFetch(`${taskPath(listId, taskId)}?$top=100`);
    return Response.json({ items: (data.value || []).map((s: any) => ({ id: String(s.id), displayName: String(s.displayName || ""), isChecked: Boolean(s.isChecked) })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const listId = String(body.listId || ""), taskId = String(body.taskId || ""), name = String(body.displayName || "").trim().slice(0, 1000);
    if (!listId || !taskId || !name) return Response.json({ error: "Trūksta parametrų." }, { status: 400 });
    const data = await graphFetch(taskPath(listId, taskId), { method: "POST", body: JSON.stringify({ displayName: name, isChecked: false }) });
    return Response.json({ id: String(data.id), displayName: String(data.displayName || name), isChecked: false }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const listId = String(body.listId || ""), taskId = String(body.taskId || ""), stepId = String(body.stepId || "");
    if (!listId || !taskId || !stepId) return Response.json({ error: "Trūksta parametrų." }, { status: 400 });
    const patch: Record<string, unknown> = {};
    if (body.isChecked !== undefined) patch.isChecked = Boolean(body.isChecked);
    if (typeof body.displayName === "string" && body.displayName.trim()) patch.displayName = body.displayName.trim().slice(0, 1000);
    if (!Object.keys(patch).length) return Response.json({ error: "Nėra pakeitimų." }, { status: 400 });
    await graphFetch(`${taskPath(listId, taskId)}/${encodeURIComponent(stepId)}`, { method: "PATCH", body: JSON.stringify(patch) });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const params = new URL(request.url).searchParams;
    const listId = params.get("listId"), taskId = params.get("taskId"), stepId = params.get("stepId");
    if (!listId || !taskId || !stepId) return Response.json({ error: "Trūksta parametrų." }, { status: 400 });
    await graphFetch(`${taskPath(listId, taskId)}/${encodeURIComponent(stepId)}`, { method: "DELETE" });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
