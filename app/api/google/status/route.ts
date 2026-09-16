import { disconnectGoogle, googleAccount, googleTasksStatus, isGoogleConfigured, isGoogleConnected, isGoogleTasksConnected } from "@/lib/google";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function GET() { return Response.json({ connected: isGoogleConnected(), configured: isGoogleConfigured(), account: googleAccount(), tasksConnected:isGoogleTasksConnected(), tasksStatus:googleTasksStatus() },{headers:{"Cache-Control":"no-store"}}); }
export async function DELETE(request: Request) {
  try { assertSameOrigin(request); disconnectGoogle(); return Response.json({ ok: true }); }
  catch (error) { return apiError(error); }
}
