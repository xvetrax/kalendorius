import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken, isAuthEnabled, SESSION_COOKIE } from "@/lib/session";

export function proxy(request: NextRequest) {
  if (!isAuthEnabled()) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // Public paths that don't require auth
  if (pathname === "/login" || pathname === "/api/health" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token)) return NextResponse.next();

  // API routes → 401 JSON
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Neprisijungta. Atnaujink puslapį ir prisijunk." }, { status: 401 });
  }

  // Pages → redirect to /login
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$).*)"],
};
