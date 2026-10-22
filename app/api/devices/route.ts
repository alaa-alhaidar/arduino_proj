import { NextResponse } from "next/server";
import { requestPi } from "../../lib/pi-mqtt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PiDevice = {
  ip: string;
  name: string;
  hostname: string;
  online: number | boolean;
  last_checked: string;
};

function isDevice(value: unknown): value is PiDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  return typeof device.ip === "string"
    && typeof device.name === "string"
    && typeof device.hostname === "string"
    && (typeof device.online === "number" || typeof device.online === "boolean")
    && typeof device.last_checked === "string";
}

export async function GET() {
  try {
    const result: unknown = await requestPi("devices");
    const devices = typeof result === "object" && result !== null
      ? (result as { devices?: unknown }).devices
      : undefined;
    if (!Array.isArray(devices) || !devices.every(isDevice)) {
      throw new Error("Ungültige Geräteliste");
    }
    return NextResponse.json({
      devices: devices.map((device) => ({
        ip: device.ip,
        name: device.name,
        hostname: device.hostname,
        online: device.online === true || device.online === 1,
        lastChecked: device.last_checked,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Geräteliste vom Pi 5 nicht erreichbar" }, { status: 503 });
  }
}
