import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "planner_session";
const SESSION_MS = 24 * 60 * 60 * 1000;

function hmacKey() {
  const k = process.env.TOKEN_ENCRYPTION_KEY;
  if (!k || k.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY nenustatytas");
  return k;
}

function signToken(payload: string): string {
  const b64 = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", hmacKey()).update(b64).digest("base64url");
  return `${b64}.${mac}`;
}

export function createSessionToken(): string {
  return signToken(JSON.stringify({ iat: Date.now() }));
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 1) return false;
    const b64 = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", hmacKey()).update(b64).digest("base64url");
    const eBuf = Buffer.from(expected), aBuf = Buffer.from(mac);
    if (eBuf.length !== aBuf.length || !timingSafeEqual(eBuf, aBuf)) return false;
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    return typeof payload.iat === "number" && Date.now() - payload.iat < SESSION_MS;
  } catch { return false; }
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, maxAge: SESSION_MS / 1000, path: "/" };
}

export function isAuthEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

export function checkPassword(provided: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  try {
    const eBuf = Buffer.from(expected), pBuf = Buffer.from(provided);
    if (eBuf.length !== pBuf.length) {
      timingSafeEqual(eBuf, eBuf);
      return false;
    }
    return timingSafeEqual(eBuf, pBuf);
  } catch { return false; }
}
