import { createHmac } from "node:crypto";
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
    const expires = Math.floor(Date.now() / 1000) + 60;
    const signature = createHmac("sha256", viewToken)
      .update(`/servo:${angle}:${expires}`)
      .digest("hex");
    const servoUrl = new URL("/servo", relayUrl);
    servoUrl.protocol = servoUrl.protocol === "wss:" ? "https:" : servoUrl.protocol === "ws:" ? "http:" : servoUrl.protocol;
    servoUrl.searchParams.set("angle", String(angle));
    servoUrl.searchParams.set("expires", String(expires));
    servoUrl.searchParams.set("signature", signature);
    const response = await fetch(servoUrl, {
      method: "GET",
      cache: "no-store",
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
