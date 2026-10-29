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

  const brokerUrl = process.env.MQTT_URL
    ?? "mqtts://jfa0c01f.ala.eu-central-1.emqxsl.com:8883";
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
