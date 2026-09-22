import crypto from "node:crypto";
import { cookies } from "next/headers";
import { generateMicrosoftPKCE, microsoftAuthUrl } from "@/lib/microsoft";
import { oauthCookieOptions, oauthResultUrl } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = generateMicrosoftPKCE();
    const jar = await cookies();
    const opts = oauthCookieOptions(request.url);
    jar.set("microsoft_oauth_state", state, opts);
    jar.set("microsoft_oauth_verifier", verifier, opts);
    return Response.redirect(microsoftAuthUrl(state, challenge));
  } catch {
    return Response.redirect(oauthResultUrl(request.url, "microsoft", "not-configured"));
  }
}
