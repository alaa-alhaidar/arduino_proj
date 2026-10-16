import { connectAsync } from "mqtt";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Telemetry = {
  sent_at?: string;
  source?: string;
  measurements: {
    temperature_c: number;
    pressure_hpa: number;
    humidity_pct: number;
    gas_resistance_ohm: number;
  };
};

function isTelemetry(value: unknown): value is Telemetry {
  if (typeof value !== "object" || value === null) return false;

  const measurements = (value as { measurements?: unknown }).measurements;
  if (typeof measurements !== "object" || measurements === null) return false;

  const data = measurements as Record<string, unknown>;
  return [
    "temperature_c",
    "pressure_hpa",
    "humidity_pct",
    "gas_resistance_ohm",
  ].every((key) => typeof data[key] === "number" && Number.isFinite(data[key]));
}

export async function GET() {
  const brokerUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:18830";
  const topic = process.env.MQTT_TELEMETRY_TOPIC ?? "iot/v1/nodes/pi-05/telemetry";

  let client: Awaited<ReturnType<typeof connectAsync>> | undefined;

  try {
    const connectedClient = await connectAsync(brokerUrl, {
      connectTimeout: 3000,
      reconnectPeriod: 0,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    });
    client = connectedClient;

    const telemetry = await new Promise<Telemetry>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Keine Sensordaten")), 7000);

      connectedClient.on("message", (_receivedTopic, payload) => {
        try {
          const parsed: unknown = JSON.parse(payload.toString());
          if (!isTelemetry(parsed)) {
            throw new Error("Ungültiges Nano-Telemetrieformat");
          }
          clearTimeout(timeout);
          resolve(parsed);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      connectedClient.subscribeAsync(topic, { qos: 1 }).catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    return NextResponse.json(telemetry, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Keine MQTT-Sensordaten verfügbar" }, { status: 503 });
  } finally {
    await client?.endAsync().catch(() => undefined);
  }
}
