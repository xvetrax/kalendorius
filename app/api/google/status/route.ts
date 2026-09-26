import {
  disconnectGoogleForUser,
  googleAccountForUser,
  googleTasksStatusForUser,
  isGoogleConfigured,
  isGoogleConnectedForUser,
  isGoogleTasksConnectedForUser,
} from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";
import { requireUserContext } from "@/lib/db-multi";

export async function GET(request: Request) {
  try {
    const user = requireUserContext(request);
    return Response.json(
      {
        connected: isGoogleConnectedForUser(user.id),
        configured: isGoogleConfigured(),
        account: googleAccountForUser(user.id),
        tasksConnected: isGoogleTasksConnectedForUser(user.id),
        tasksStatus: googleTasksStatusForUser(user.id),
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
    disconnectGoogleForUser(user.id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiError(error);
  }
}
