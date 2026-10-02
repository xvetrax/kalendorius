import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/db-multi";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths that don't require auth
  if (
    pathname === "/login" ||
    pathname === "/api/health" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/pwa/") ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && getUserFromSession(token)) return NextResponse.next();

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
