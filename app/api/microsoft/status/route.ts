import { disconnectMicrosoft, isMicrosoftConfigured, isMicrosoftConnected, microsoftAccount } from "@/lib/microsoft";
import { apiError, assertSameOrigin } from "@/lib/http";

export async function GET() { return Response.json({ connected: isMicrosoftConnected(), configured: isMicrosoftConfigured(), account: microsoftAccount() }); }
export async function DELETE(request: Request) {
  try { assertSameOrigin(request); disconnectMicrosoft(); return Response.json({ ok: true }); }
  catch (error) { return apiError(error); }
}
