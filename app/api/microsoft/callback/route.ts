import { cookies } from "next/headers";
import { exchangeMicrosoftCode } from "@/lib/microsoft";
import { oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  const url = new URL(request.url); const jar = await cookies();
  const expectedState = jar.get("microsoft_oauth_state")?.value;
  jar.delete("microsoft_oauth_state");
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== expectedState) return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  try {
    await exchangeMicrosoftCode(code);
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "connected"));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "error"));
  }
}
