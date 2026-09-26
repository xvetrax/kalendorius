import {
  disconnectMicrosoftForUser,
  isMicrosoftConfigured,
  isMicrosoftConnectedForUser,
  microsoftAccountForUser,
} from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";
import { requireUserContext } from "@/lib/db-multi";

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    return Response.json(
      {
        connected: isMicrosoftConnectedForUser(user.id),
        configured: isMicrosoftConfigured(),
        account: microsoftAccountForUser(user.id),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = requireUserContext(request);
    disconnectMicrosoftForUser(user.id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}
