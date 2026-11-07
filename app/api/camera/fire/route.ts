import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  const viewToken = process.env.CAMERA_VIEW_TOKEN;
  if (!relayUrl || !viewToken) {
    return NextResponse.json({ error: "Kamera-Relay ist nicht konfiguriert" }, { status: 503 });
  }

  try {
    const response = await fetch(new URL("/fire/status", relayUrl), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${viewToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: "Feuererkennung nicht erreichbar" }, { status: 502 });
    }
    const status = await response.json();
    return NextResponse.json({
      ready: status.ready === true,
      alarm: status.alarm === true,
      detected: status.detected === true,
      confidence: typeof status.confidence === "number" ? status.confidence : 0,
      positives: typeof status.positives === "number" ? status.positives : 0,
      window_size: typeof status.window_size === "number" ? status.window_size : 0,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Feuererkennung nicht erreichbar" }, { status: 503 });
  }
}
