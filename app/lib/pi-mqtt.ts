import { randomUUID } from "node:crypto";
import { connectAsync } from "mqtt";

export type PiAction = "start" | "stop" | "status" | "devices" | "alarm_state";

export async function requestPi<T>(action: PiAction): Promise<T> {
  const token = process.env.PI_CONTROL_TOKEN;
  if (!token) throw new Error("Pi-MQTT-Steuerung ist nicht konfiguriert");

  const brokerUrl = process.env.MQTT_URL ?? "mqtt://127.0.0.1:18830";
  const commandTopic = process.env.MQTT_PI_CONTROL_TOPIC
    ?? "htw/alaa/iot2026/pi-05/commands/control";
  const stateTopic = process.env.MQTT_PI_CONTROL_STATE_TOPIC
    ?? "htw/alaa/iot2026/pi-05/state/control";
  const requestId = randomUUID();
  let client: Awaited<ReturnType<typeof connectAsync>> | undefined;

  try {
    client = await connectAsync(brokerUrl, {
      connectTimeout: 10000,
      reconnectPeriod: 0,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    });
    await client.subscribeAsync(stateTopic, { qos: 1 });

    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Keine Antwort vom Pi")), 10000);
      client?.on("message", (topic, payload) => {
        if (topic !== stateTopic) return;
        try {
          const message = JSON.parse(payload.toString()) as {
            request_id?: unknown;
            ok?: unknown;
            error?: unknown;
            data?: unknown;
          };
          if (message.request_id !== requestId) return;
          clearTimeout(timeout);
          if (message.ok !== true) {
            reject(new Error(typeof message.error === "string" ? message.error : "Pi-Befehl fehlgeschlagen"));
            return;
          }
          resolve(message.data as T);
        } catch {
          // Retained oder fremde Nachrichten werden ignoriert.
        }
      });
    });

    await client.publishAsync(commandTopic, JSON.stringify({
      action,
      request_id: requestId,
      token,
    }), { qos: 1, retain: false });
    return await response;
  } finally {
    await client?.endAsync().catch(() => undefined);
  }
}
