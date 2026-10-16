import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "start" | "stop" | "status";

async function callPi(action: Action) {
  const baseUrl = process.env.PI_CONTROL_URL;
  const token = process.env.PI_CONTROL_TOKEN;
  if (!baseUrl || !token) {
    return NextResponse.json(
      { error: "Pi-Kontrollstation ist nicht konfiguriert" },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${action}`, {
      method: action === "status" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      // Stopping the Docker stack can legitimately take longer than 10 seconds.
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: "Pi-Kontrollstation über HTTPS nicht erreichbar" },
      { status: 503 },
    );
  }
}

export async function GET() {
  return callPi("status");
}

export async function POST(request: Request) {
  let action: unknown;
  try {
    action = (await request.json() as { action?: unknown }).action;
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: "Ungültige Aktion" }, { status: 400 });
  }
  return callPi(action);
}
