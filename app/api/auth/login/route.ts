import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, SESSION_DURATION_SECONDS } from "../../../lib/auth";

function secureEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function POST(request: Request) {
  const configuredUsername = process.env.DASHBOARD_USERNAME ?? "";
  const configuredPassword = process.env.DASHBOARD_PASSWORD ?? "";
  const secret = process.env.AUTH_SECRET ?? "";
  if (!configuredUsername || !configuredPassword || !secret) {
    return NextResponse.json({ error: "Anmeldung ist nicht konfiguriert." }, { status: 503 });
  }

  const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const usernameValid = secureEqual(username, configuredUsername);
  const passwordValid = secureEqual(password, configuredPassword);
  if (!usernameValid || !passwordValid) {
    return NextResponse.json({ error: "Benutzername oder Passwort ist falsch." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(configuredUsername, secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
  return response;
}
