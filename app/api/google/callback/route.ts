import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/google";
import { oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expectedState = jar.get("google_oauth_state")?.value;
  jar.delete("google_oauth_state");
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== expectedState) return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  try {
    await exchangeCode(code);
    return Response.redirect(oauthResultUrl(request.url, "google", "connected"));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }
}
