import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  const viewToken = process.env.CAMERA_VIEW_TOKEN;
  if (!relayUrl || !viewToken) {
    return NextResponse.json(
      { error: "Kamera-Relay ist nicht konfiguriert" },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(new URL("/frame", relayUrl), {
      cache: "no-store",
      headers: { Authorization: `Bearer ${viewToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 503 ? "Kein aktuelles Kamerabild" : "Kamera nicht erreichbar" },
        { status: response.status === 503 ? 503 : 502 },
      );
    }

    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
        "CDN-Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch {
    return NextResponse.json({ error: "Kamera-Relay nicht erreichbar" }, { status: 503 });
  }
}
