import { createSessionToken, checkPassword, sessionCookieOptions, SESSION_COOKIE, isAuthEnabled } from "@/lib/session";
import { appOrigin } from "@/lib/http";

export const runtime = "nodejs";

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

export async function POST(request: Request) {
  if (!isAuthEnabled()) {
    return Response.json({ error: "Prisijungimas išjungtas." }, { status: 409 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(ip)) {
    return Response.json({ error: "Per daug bandymų. Palaukite minutę." }, { status: 429 });
  }

  let password: string;
  try {
    const body = await request.json();
    password = String(body.password ?? "");
  } catch {
    return Response.json({ error: "Neteisingi duomenys." }, { status: 400 });
  }

  if (!checkPassword(password)) {
    return Response.json({ error: "Neteisingas slaptažodis." }, { status: 401 });
  }

  const secure = appOrigin(request.url).startsWith("https://");
  const token = createSessionToken();
  const opts = sessionCookieOptions(secure);

  const resp = Response.json({ ok: true });
  resp.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=${opts.path}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? "; Secure" : ""}`
  );
  return resp;
}
