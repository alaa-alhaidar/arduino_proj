# Sensor Campus PWA

Eine Next.js-PWA zur Anzeige der Sensordaten eines Arduino Nano, die über den Raspberry Pi 5 per MQTT bereitgestellt werden, sowie zur Steuerung der LED-/Buzzer-Alarmschaltung.

## Lokal starten

```bash
npm install
cp .env.example .env.local
npm run dev
```

Danach ist die Oberfläche unter `http://localhost:3000` erreichbar.

## IoT-Geräte-Buttons

Das Dashboard zeigt den Nano und zwei ESP32-CAMs als Geräte-Buttons. Die
Adressen der Kameras werden in `.env.local` konfiguriert:

```text
NEXT_PUBLIC_ESP_CAM_1_URL=http://192.168.178.201
NEXT_PUBLIC_ESP_CAM_2_URL=http://192.168.178.202
```

Ohne konfigurierte URL bleibt der jeweilige Kamera-Button sichtbar, ist aber
deaktiviert. Nach einer Änderung der Variablen muss Next.js neu gestartet werden.

Die Next.js-API veröffentlicht Schaltbefehle im MQTT-Thema:

```text
iot/v1/nodes/pi-05/commands/alarm
```

Die PWA liest die Nano-Sensordaten aus:

```text
iot/v1/nodes/pi-05/telemetry
```

Der Pi 5 muss dort retained JSON-Nachrichten in diesem Format veröffentlichen:

```json
{
  "sent_at": "2026-10-16T12:00:00Z",
  "source": "nano",
  "measurements": {
    "temperature_c": 23.4,
    "pressure_hpa": 1013.2,
    "humidity_pct": 48.1,
    "gas_resistance_ohm": 120000
  }
}
```

## Pi-5-Dienste

Die Python-Dienste für GPIO, MQTT und die Kontroll-API laufen separat auf dem Pi 5. Dieses Repository enthält nur das Next.js-PWA-Dashboard. Wenn Next.js lokal auf dem Mac läuft, verbindet es sich über `MQTT_URL` direkt mit dem MQTT-Broker des Pi 5.
