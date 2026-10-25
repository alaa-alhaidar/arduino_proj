import { NextResponse } from "next/server";
import { requestPi } from "../../lib/pi-mqtt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "start" | "stop" | "status";

async function callPi(action: Action) {
  try {
    const data = await requestPi<Record<string, unknown>>(action);
    const alarmControl = action === "status"
      ? await requestPi<Record<string, unknown>>("alarm_state").catch(() => undefined)
      : undefined;
    return NextResponse.json(alarmControl ? { ...data, alarm_control: alarmControl } : data, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pi-Kontrollstation über MQTT nicht erreichbar" },
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
