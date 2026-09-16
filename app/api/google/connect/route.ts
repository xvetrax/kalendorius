import crypto from "node:crypto";
import { cookies } from "next/headers";
import { googleAuthUrl } from "@/lib/google";
import { oauthCookieOptions, oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    (await cookies()).set("google_oauth_state", state, oauthCookieOptions(request.url));
    return Response.redirect(googleAuthUrl(state));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "not-configured"));
  }
}
