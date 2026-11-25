import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
export: Next.js kann die Funktion als API-Handler verwenden.
async: Die Funktion arbeitet asynchron und darf auf Vorgänge warten.
POST: Next.js ruft sie bei einer eingehenden POST-Anfrage auf.
request: enthält die empfangene Anfrage.
NextRequest: TypeScript-Typ dieser Anfrage.

Diese Funktion empfängt den Winkel vom PWA-Browser und leitet ihn an
das Kamera-Relay weiter. Sie prüft, ob die Kamera konfiguriert ist,
ob der Winkel gültig ist und ob das Relay erreichbar ist. Bei Erfolg
gibt sie den gesetzten Winkel zurück, bei Fehlern entsprechende
Fehlermeldungen.
*/
export async function POST(request: NextRequest) {
  const relayUrl = process.env.CAMERA_RELAY_URL;
  const viewToken = process.env.CAMERA_VIEW_TOKEN;
  if (!relayUrl || !viewToken) {
    return NextResponse.json({ error: "Kamera ist nicht konfiguriert" }, { status: 503 });
  }

  let angle: number;
  try {
    const payload = await request.json() as { angle?: unknown };
    angle = Number(payload.angle);
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  if (!Number.isInteger(angle) || angle < 0 || angle > 180) {
    return NextResponse.json({ error: "Winkel muss zwischen 0 und 180 liegen" }, { status: 400 });
  }
  /*
    Sendet den Servowinkel per HTTP-POST an den
    /servo-Endpunkt des Raspberry Pi 5.
  */

  /*
  fetch()                    = HTTP-Anfrage senden
  method: "POST"             = Daten an den Server übertragen
  body: JSON.stringify(...)  = übertragene Daten
  await                      = auf Serverantwort warten
  response                   = Antwort des Servers

  */

  try {
    const servoUrl = new URL("/servo", relayUrl);
    servoUrl.protocol = servoUrl.protocol === "wss:" ? "https:" : servoUrl.protocol === "ws:" ? "http:" : servoUrl.protocol;
    const response = await fetch(servoUrl, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${viewToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ angle }),
      signal: AbortSignal.timeout(3000),
    });

    /*
      Liest die JSON-Antwort des Pi-5-Relays.
      Beispiel: { "ok": true, "angle": 120 }
    */
    const result = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { error: result.error ?? "Servobefehl fehlgeschlagen" },
        { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
      );
    }
    return NextResponse.json({ angle: result.angle });
  } catch {
    return NextResponse.json({ error: "Kamera-Relay nicht erreichbar" }, { status: 503 });
  }
}
