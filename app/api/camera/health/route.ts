import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  if (!relayUrl) {
    return NextResponse.json({ online: false }, { status: 503 });
  }

  try {
    const response = await fetch(new URL("/health", relayUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Relay nicht erreichbar");
    const status = await response.json() as {
      frame_available?: unknown;
      frame_age_seconds?: unknown;
    };
    const frameAge = typeof status.frame_age_seconds === "number"
      ? status.frame_age_seconds
      : Number.POSITIVE_INFINITY;
    return NextResponse.json(
      { online: status.frame_available === true && frameAge <= 10, frameAge },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { online: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
