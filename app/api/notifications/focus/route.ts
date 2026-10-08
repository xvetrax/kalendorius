import { requireUserContext } from "@/lib/db-multi";
import { assertSameOrigin } from "@/lib/http";
import { cancelFocusEnd, NotificationJobError, scheduleFocusEnd } from "@/lib/notification-jobs";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof NotificationJobError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  if (error instanceof Error && error.message === "CSRF") return Response.json({ error: "Užklausa atmesta dėl saugumo patikros." }, { status: 403 });
  console.error("[focus_notification] request failed", error);
  return Response.json({ error: "Fokusavimo priminimo išsaugoti nepavyko." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json() as { operationId?: unknown; endsAt?: unknown };
    return Response.json(scheduleFocusEnd(user.id, body.operationId, body.endsAt));
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json() as { operationId?: unknown };
    return Response.json(cancelFocusEnd(user.id, body.operationId));
  } catch (error) { return failure(error); }
}
