import { requireUserContext } from "@/lib/db-multi";
import { assertSameOrigin } from "@/lib/http";
import { getNotificationPreferences, NotificationJobError, updateFocusPreference } from "@/lib/notification-jobs";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof NotificationJobError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  if (error instanceof Error && error.message === "CSRF") return Response.json({ error: "Užklausa atmesta dėl saugumo patikros." }, { status: 403 });
  console.error("[notification_preferences] request failed", error);
  return Response.json({ error: "Pranešimų nuostatų išsaugoti nepavyko." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    return Response.json(getNotificationPreferences(user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json() as { focusEndEnabled?: unknown };
    if (typeof body.focusEndEnabled !== "boolean") throw new NotificationJobError("Neteisinga fokusavimo priminimo nuostata.");
    return Response.json(updateFocusPreference(user.id, body.focusEndEnabled));
  } catch (error) { return failure(error); }
}

