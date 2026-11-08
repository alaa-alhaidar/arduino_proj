import { NextResponse } from "next/server";
import { requestPi } from "../../lib/pi-mqtt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await requestPi<{ events: unknown[] }>("events");
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ereignisprotokoll nicht erreichbar" },
      { status: 503 },
    );
  }
}
