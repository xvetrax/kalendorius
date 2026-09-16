import crypto from "node:crypto";
import { cookies } from "next/headers";
import { microsoftAuthUrl } from "@/lib/microsoft";
import { oauthCookieOptions, oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    (await cookies()).set("microsoft_oauth_state", state, oauthCookieOptions(request.url));
    return Response.redirect(microsoftAuthUrl(state));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "not-configured"));
  }
}
