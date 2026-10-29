import { connectAsync } from "mqtt";
import { NextResponse } from "next/server";
import { requestPi } from "../../lib/pi-mqtt";

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

function telemetryForDashboard(telemetry: Telemetry) {
  const alarm = (telemetry as Telemetry & {
    alarm_control?: Record<string, unknown>;
  }).alarm_control;
  if (!alarm) return telemetry;

  const {
    ranges,
    automatic_alarm,
    automatic_alarm_acknowledged,
    manual_alarm,
    alarm_active,
    updated_at,
  } = alarm;
  return {
    ...telemetry,
    alarm_control: {
      ranges,
      automatic_alarm,
      automatic_alarm_acknowledged,
      manual_alarm,
      alarm_active,
      updated_at,
    },
  };
}

export async function GET() {
  try {
    const status = await requestPi<{ running?: unknown }>("status");
    if (status.running !== true) {
      return NextResponse.json({ error: "Pi-Kontrollstation ist gestoppt" }, { status: 503 });
    }
  } catch {
    return NextResponse.json({ error: "Pi-Kontrollstation über MQTT nicht erreichbar" }, { status: 503 });
  }

  const brokerUrl = process.env.MQTT_URL
    ?? "mqtts://jfa0c01f.ala.eu-central-1.emqxsl.com:8883";
  const topic = process.env.MQTT_TELEMETRY_TOPIC ?? "iot/v1/nodes/pi-05/telemetry";

  let client: Awaited<ReturnType<typeof connectAsync>> | undefined;
  const alarmState = requestPi<Record<string, unknown>>("alarm_state").catch(() => undefined);

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

    const control = await alarmState;
    return NextResponse.json(
      control ? telemetryForDashboard({ ...telemetry, alarm_control: control } as Telemetry) : telemetry,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Keine MQTT-Sensordaten verfügbar" }, { status: 503 });
  } finally {
    await client?.endAsync().catch(() => undefined);
  }
}
