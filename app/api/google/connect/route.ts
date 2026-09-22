import crypto from "node:crypto";
import { cookies } from "next/headers";
import { generatePKCE, googleAuthUrl } from "@/lib/google";
import { oauthCookieOptions, oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = generatePKCE();
    const jar = await cookies();
    const opts = oauthCookieOptions(request.url);
    jar.set("google_oauth_state", state, opts);
    jar.set("google_oauth_verifier", verifier, opts);
    return Response.redirect(googleAuthUrl(state, challenge));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "google", "not-configured"));
  }
}
