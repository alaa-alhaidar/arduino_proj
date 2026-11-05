import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  const viewToken = process.env.CAMERA_VIEW_TOKEN;
  if (!relayUrl || !viewToken) {
    return NextResponse.json({ error: "Kamera ist nicht konfiguriert" }, { status: 503 });
  }

  let angle: number;
  try {
    const payload = await request.json() as { angle?: unknown };
    angle = Number(payload.angle);
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  if (!Number.isInteger(angle) || angle < 0 || angle > 180) {
    return NextResponse.json({ error: "Winkel muss zwischen 0 und 180 liegen" }, { status: 400 });
  }

  try {
    const response = await fetch(new URL("/servo", relayUrl), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${viewToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ angle }),
      signal: AbortSignal.timeout(3000),
    });
    const result = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { error: result.error ?? "Servobefehl fehlgeschlagen" },
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
      );
    }
    return NextResponse.json({ angle: result.angle });
  } catch {
    return NextResponse.json({ error: "Kamera-Relay nicht erreichbar" }, { status: 503 });
  }
}
