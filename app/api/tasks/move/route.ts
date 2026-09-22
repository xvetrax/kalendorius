import { googleAccountId, googleTasksFetch, isGoogleTasksConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import { TaskError } from "@/lib/task-service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    const { source, account_id, list_id, id, destination_list_id } = body;
    if (source !== "google") return Response.json({ error: "Tik Google užduotys gali būti perkeltos tarp sąrašų." }, { status: 400 });
    if (!list_id || !id || !destination_list_id || list_id === destination_list_id) return Response.json({ error: "Trūksta arba netinkami parametrai." }, { status: 400 });
    if (!isGoogleTasksConnected()) return Response.json({ error: "Google Tasks neprijungta." }, { status: 409 });
    const currentAccountId = await googleAccountId();
    if (account_id && account_id !== currentAccountId) return Response.json({ error: "Paskyra pasikeitė. Atnaujink duomenis." }, { status: 409 });
    const params = new URLSearchParams({ destinationTasklist: String(destination_list_id) });
    await googleTasksFetch(`/lists/${encodeURIComponent(String(list_id))}/tasks/${encodeURIComponent(String(id))}/move?${params}`, { method: "POST" });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof TaskError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error);
  }
}
