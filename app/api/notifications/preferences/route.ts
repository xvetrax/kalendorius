import { requireUserContext } from "@/lib/db-multi";
import { assertSameOrigin } from "@/lib/http";
import {
  getNotificationPreferences,
  NotificationJobError,
  updateDailyRitualPreferences,
  updateFocusPreference,
  updateTaskStartPreference,
} from "@/lib/notification-jobs";

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
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NotificationJobError("Neteisinga pranešimų nuostata.");
    const body = raw as {
      focusEndEnabled?: unknown;
      taskStartEnabled?: unknown;
      taskStartLeadMinutes?: unknown;
      dailyRituals?: unknown;
    };
    const keys = Object.keys(body);
    if (typeof body.focusEndEnabled === "boolean"
      && keys.length === 1
      && body.taskStartEnabled === undefined
      && body.taskStartLeadMinutes === undefined
      && body.dailyRituals === undefined) {
      return Response.json(updateFocusPreference(user.id, body.focusEndEnabled));
    }
    if (typeof body.taskStartEnabled === "boolean"
      && typeof body.taskStartLeadMinutes === "number"
      && keys.length === 2
      && body.focusEndEnabled === undefined
      && body.dailyRituals === undefined) {
      return Response.json(updateTaskStartPreference(user.id, body.taskStartEnabled, body.taskStartLeadMinutes));
    }
    if (body.dailyRituals !== undefined
      && keys.length === 1
      && body.focusEndEnabled === undefined
      && body.taskStartEnabled === undefined
      && body.taskStartLeadMinutes === undefined) {
      return Response.json(updateDailyRitualPreferences(user.id, body.dailyRituals));
    }
    throw new NotificationJobError("Neteisinga pranešimų nuostata.");
  } catch (error) { return failure(error); }
}
