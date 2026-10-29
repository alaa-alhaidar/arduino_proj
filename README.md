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

Das Dashboard lädt die auf dem Pi 5 registrierten Geräte dynamisch über die
geschützte MQTT-Steuerung. Für jedes Gerät zeigt es Node-Nummer, Gerätetyp,
IP-Adresse und den aktuellen Online-Status des Pi-Scanners an.

Die Next.js-API veröffentlicht Schaltbefehle im MQTT-Thema:

```text
htw/alaa/iot2026/nano-01/commands/alarm
```

Die PWA liest die Nano-Sensordaten verschlüsselt über MQTT/TLS auf Port 8883 aus:

```text
htw/alaa/iot2026/nano-01/telemetry
```

Nano, Pi 5 und PWA verwenden für Telemetrie, Alarmsteuerung und Kontrollbefehle
denselben privaten EMQX-Cloud-Broker mit dem System-CA-Speicher. Die eigenständige
Nano-Firmware liegt außerhalb dieses PWA-Projekts im Ordner `arduino-code`.

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

Die Python-Dienste für GPIO, MQTT und die Kontroll-API laufen separat auf dem
Pi 5. Wenn Next.js lokal auf dem Mac läuft, verbindet es sich über `MQTT_URL`
verschlüsselt mit demselben privaten EMQX-Cloud-Broker.

## Kamera-Relay

`deploy/pi_camera_relay.py` nimmt JPEG-Frames des ESP32-S3-CAM auf dem Pi 5
entgegen und verteilt neue Frames sofort an verbundene WebSocket-Clients.
Die PWA erhält über `/api/camera/session` eine kurzlebige, signierte WSS-URL;
dadurch bleibt das Viewer-Token ausschließlich auf dem Server.

Pi-Konfiguration in `/home/alaa/.config/sensor-campus/camera.env`:

```text
CAMERA_UPLOAD_TOKEN=<zufälliges langes Token>
CAMERA_VIEW_TOKEN=<anderes zufälliges langes Token>
CAMERA_RELAY_HOST=127.0.0.1
CAMERA_RELAY_PORT=8766
CAMERA_WS_HOST=127.0.0.1
CAMERA_WS_PORT=8767
```

Die öffentliche PWA benötigt `CAMERA_RELAY_URL` und dasselbe
`CAMERA_VIEW_TOKEN`. Port 8767 wird über einen HTTPS-/WebSocket-Tunnel oder
Reverse Proxy veröffentlicht; der Upload-Port 8766 bleibt im lokalen Netz.
