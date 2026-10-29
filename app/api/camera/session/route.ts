import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  const viewToken = process.env.CAMERA_VIEW_TOKEN;
  if (!relayUrl || !viewToken) {
    return NextResponse.json({ error: "Kamera ist nicht konfiguriert" }, { status: 503 });
  }

  const expires = Math.floor(Date.now() / 1000) + 60;
  const signature = createHmac("sha256", viewToken)
    .update(`/ws:${expires}`)
    .digest("hex");
  const socketUrl = new URL("/ws", relayUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("expires", String(expires));
  socketUrl.searchParams.set("signature", signature);

  return NextResponse.json(
    { url: socketUrl.toString(), expires },
    { headers: { "Cache-Control": "no-store" } },
  );
}
