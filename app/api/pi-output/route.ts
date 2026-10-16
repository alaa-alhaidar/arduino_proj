import { connectAsync } from "mqtt";
import { randomUUID } from "node:crypto";
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

  const controlUrl = process.env.PI_CONTROL_URL;
  const controlToken = process.env.PI_CONTROL_TOKEN;
  if (controlUrl && controlToken) {
    try {
      const response = await fetch(`${controlUrl.replace(/\/$/, "")}/alarm`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    } catch {
      return NextResponse.json({ error: "Pi-Alarm über HTTPS nicht erreichbar" }, { status: 503 });
    }
  }

  const brokerUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:18830";
  const topic = process.env.MQTT_ALARM_TOPIC ?? "iot/v1/nodes/pi-05/commands/alarm";
  const stateTopic = process.env.MQTT_ALARM_STATE_TOPIC ?? "iot/v1/nodes/pi-05/state/alarm";
  const requestId = randomUUID();
  let client: Awaited<ReturnType<typeof connectAsync>> | undefined;

  try {
    const connectedClient = await connectAsync(brokerUrl, {
      connectTimeout: 3000,
      reconnectPeriod: 0,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    });
    client = connectedClient;
    await connectedClient.subscribeAsync(stateTopic, { qos: 1 });

    const confirmation = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Keine Bestätigung vom Pi")),
        5000,
      );
      connectedClient.on("message", (receivedTopic, payload) => {
        if (receivedTopic !== stateTopic) return;
        try {
          const state = JSON.parse(payload.toString()) as {
            enabled?: unknown;
            request_id?: unknown;
          };
          if (state.request_id === requestId && state.enabled === enabled) {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // Andere oder alte retained Statusmeldungen werden ignoriert.
        }
      });
    });

    await connectedClient.publishAsync(
      topic,
      JSON.stringify({ enabled, request_id: requestId }),
      { qos: 1, retain: false },
    );
    await confirmation;
    return NextResponse.json({ ok: true, enabled });
  } catch {
    return NextResponse.json(
      { error: "Raspberry Pi hat den Schaltbefehl nicht bestätigt" },
      { status: 503 },
    );
  } finally {
    await client?.endAsync().catch(() => undefined);
  }
}
