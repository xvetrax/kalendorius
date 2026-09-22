import { isGoogleConfigured } from "@/lib/google";
import { isMicrosoftConfigured } from "@/lib/microsoft";
import { isTokenEncryptionConfigured } from "@/lib/secrets";
import { isAuthEnabled } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const env = process.env;
  const checks = {
    TOKEN_ENCRYPTION_KEY: isTokenEncryptionConfigured() ? "ok" : "missing",
    APP_ORIGIN: env.APP_ORIGIN ? "ok" : "using request origin",
    APP_PASSWORD: isAuthEnabled() ? "set" : "not set — auth disabled",
    google: isGoogleConfigured() ? "ok" : "not configured",
    microsoft: isMicrosoftConfigured() ? "ok" : "not configured",
    DATABASE_PATH: env.DATABASE_PATH || "(default: ./data/planner.db)",
  };
  const issues = Object.entries(checks).filter(([, v]) => v === "missing" || v === "not configured");
  return Response.json({ ok: issues.length === 0, checks }, { headers: { "Cache-Control": "no-store" } });
}
