import { connectAsync } from "mqtt";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled muss true oder false sein" }, { status: 400 });
  }

  const brokerUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:18830";
  const topic = process.env.MQTT_ALARM_TOPIC ?? "iot/v1/nodes/pi-05/commands/alarm";

  try {
    const client = await connectAsync(brokerUrl, {
      connectTimeout: 3000,
      reconnectPeriod: 0,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    });
    await client.publishAsync(topic, JSON.stringify({ enabled }), { qos: 1, retain: true });
    await client.endAsync();
    return NextResponse.json({ ok: true, enabled });
  } catch {
    return NextResponse.json({ error: "Raspberry Pi nicht erreichbar" }, { status: 503 });
  }
}
