import { isGoogleConfigured } from "@/lib/google";
import { isMicrosoftConfigured } from "@/lib/microsoft";
import { isTokenEncryptionConfigured } from "@/lib/secrets";
import { isPublicSignupEnabled } from "@/lib/user-service";
import { requireUserContext } from "@/lib/db-multi";
import { pushConfiguration } from "@/lib/push-notifications";
import pkg from "@/package.json";

export const runtime = "nodejs";

export async function GET(request: Request) {
  requireUserContext(request);
  const env = process.env;
  const checks = {
    TOKEN_ENCRYPTION_KEY: isTokenEncryptionConfigured() ? "ok" : "missing",
    APP_ORIGIN: env.APP_ORIGIN ? "ok" : "using request origin",
    authentication: "Google / Microsoft OIDC",
    PUBLIC_SIGNUP: isPublicSignupEnabled() ? "enabled" : "disabled",
    INITIAL_ADMIN_EMAIL: env.INITIAL_ADMIN_EMAIL ? "set" : "first account becomes admin",
    google: isGoogleConfigured() ? "ok" : "not configured",
    microsoft: isMicrosoftConfigured() ? "ok" : "not configured",
    webPush: pushConfiguration().configured ? "ok" : "not configured",
    DATABASE_PATH: env.DATABASE_PATH || "(default: ./data/planner.db)",
  };
  const issues = Object.entries(checks).filter(([, v]) => v === "missing" || v === "not configured");
  return Response.json({ ok: issues.length === 0, version: pkg.version, checks }, { headers: { "Cache-Control": "no-store" } });
}
