import { cookies } from "next/headers";
import { exchangeCode, isGoogleConnected, isGoogleTasksConnected } from "@/lib/google";
import { oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expectedState = jar.get("google_oauth_state")?.value;
  const verifier = jar.get("google_oauth_verifier")?.value;
  jar.delete("google_oauth_state");
  jar.delete("google_oauth_verifier");
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== expectedState || !verifier) {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }
  if (url.searchParams.get("error") === "access_denied" && isGoogleConnected() && !isGoogleTasksConnected()) {
    return Response.redirect(oauthResultUrl(request.url, "google", "tasks-permission-required"));
  }
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  try {
    const result = await exchangeCode(code, verifier);
    return Response.redirect(oauthResultUrl(request.url, "google", result.tasksConnected ? "connected" : "tasks-permission-required"));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "error"));
  }
}
