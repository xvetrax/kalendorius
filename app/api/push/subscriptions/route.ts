import { assertSameOrigin } from "@/lib/http";
import { requireUserContext } from "@/lib/db-multi";
import {
  deletePushSubscription,
  listPushSubscriptions,
  parsePushSubscription,
  pushConfiguration,
  PushNotificationError,
  savePushSubscription,
} from "@/lib/push-notifications";

export const runtime = "nodejs";

function failure(error: unknown) {
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
  console.error("[push_subscriptions] request failed", error);
  return Response.json({ error: "Pranešimų nustatymų išsaugoti nepavyko." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    const config = pushConfiguration();
    return Response.json({
      configured: config.configured,
      publicKey: config.configured ? config.publicKey : "",
      subscriptions: listPushSubscriptions(user.id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    if (!pushConfiguration().configured) {
      throw new PushNotificationError("Pranešimai serveryje dar nesukonfigūruoti.", 409);
    }
    const subscription = parsePushSubscription(await request.json());
    const id = savePushSubscription(user.id, subscription);
    return Response.json({ id, subscriptions: listPushSubscriptions(user.id) }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    const body = await request.json() as { id?: unknown };
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PushNotificationError("Neteisingas prenumeratos identifikatorius.");
    }
    if (!deletePushSubscription(user.id, id)) {
      throw new PushNotificationError("Pranešimų įrenginys nerastas.", 404);
    }
    return Response.json({ ok: true, subscriptions: listPushSubscriptions(user.id) });
  } catch (error) {
    return failure(error);
  }
}
