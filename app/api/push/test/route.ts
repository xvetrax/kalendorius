import { requireUserContext } from "@/lib/db-multi";
import { assertSameOrigin } from "@/lib/http";
import { PushNotificationError, sendTestPush } from "@/lib/push-notifications";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json() as { id?: unknown };
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PushNotificationError("Neteisingas prenumeratos identifikatorius.");
    }
    await sendTestPush(user.id, id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof PushNotificationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
    }
    if (error instanceof Error && error.message === "CSRF") {
      return Response.json({ error: "Užklausa atmesta dėl saugumo patikros." }, { status: 403 });
    }
    console.error("[push_test] request failed", error);
    return Response.json({ error: "Bandomojo pranešimo išsiųsti nepavyko." }, { status: 500 });
  }
}
