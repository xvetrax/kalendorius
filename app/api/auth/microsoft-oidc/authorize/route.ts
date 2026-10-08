/**
 * GET /api/auth/microsoft-oidc/authorize
 *
 * Entry point for Microsoft OIDC login. No auth required.
 * Generates state, nonce, PKCE; stores auth_operation in DB; redirects to Microsoft.
 *
 * Security:
 *   - state stored only as SHA-256 hash (state_hash) in DB; raw value in redirect only.
 *   - nonce stored in DB; verified in callback against id_token claim.
 *   - PKCE verifier stored in DB server-side; challenge sent to provider.
 *   - A valid existing session turns this into an explicit identity-link flow.
 */

import { randomBytes, createHash } from "node:crypto";
import { db, SESSION_COOKIE } from "@/lib/db-multi";
import { appOrigin } from "@/lib/http";

export const runtime = "nodejs";

const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function sha256Base64url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

function nowPlus(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return Response.json({ error: "Microsoft OIDC not configured." }, { status: 503 });
  }

  // If a user is already logged in, record session_id for identity linking
  let sessionId: number | null = null;
  try {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const rawToken = parseCookieValue(cookieHeader, SESSION_COOKIE);
    if (rawToken) {
      const tokenHash = sha256Hex(rawToken);
      const session = db
        .prepare(
          `SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
        )
        .get(tokenHash) as { id: number } | undefined;
      if (session) sessionId = session.id;
    }
  } catch {
    // Not logged in — that's fine
  }

  // Generate state, nonce, PKCE
  const rawState = randomBytes(32).toString("hex");
  const stateHash = sha256Hex(rawState);
  const nonce = randomBytes(32).toString("hex");
  const pkceVerifier = randomBytes(32).toString("base64url");
  const pkceChallenge = sha256Base64url(pkceVerifier);

  // Store auth_operation
  db.prepare(`
    INSERT INTO auth_operations (state_hash, nonce, pkce_verifier, provider, session_id, callback_path, expires_at, used)
    VALUES (?, ?, ?, 'microsoft', ?, '/api/auth/microsoft-oidc/callback', ?, 0)
  `).run(stateHash, nonce, pkceVerifier, sessionId, nowPlus(10));

  // Build redirect URI
  const origin = appOrigin(request.url);
  const redirectUri = `${origin}/api/auth/microsoft-oidc/callback`;

  // Build Microsoft authorization URL (multi-tenant: /common endpoint)
  const authUrl = new URL(MICROSOFT_AUTH_BASE);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", rawState);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", pkceChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("response_mode", "query");

  // Fix 1: Bind state to browser via cookie (CSRF protection)
  const secure = origin.startsWith("https://");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `oauth_state_ms=${rawState}; Path=/api/auth/microsoft-oidc/callback; Max-Age=600; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Cookie parser
// ---------------------------------------------------------------------------

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim() || null;
  }
  return null;
}
