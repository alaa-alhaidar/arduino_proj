import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./app/lib/auth";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginPage = pathname === "/login";
  const isLoginRequest = pathname === "/api/auth/login";
  if (isLoginRequest) return NextResponse.next();

  const username = process.env.DASHBOARD_USERNAME ?? "";
  const secret = process.env.AUTH_SECRET ?? "";
  const authenticated = await verifySessionToken(
    request.cookies.get(SESSION_COOKIE)?.value,
    secret,
    username,
  );

  if (isLoginPage) {
    return authenticated ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (authenticated) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Nicht angemeldet" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js).*)"],
};
