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
geschützte Kontroll-API. Für jedes Gerät zeigt es Node-Nummer, Gerätetyp,
IP-Adresse und den aktuellen Online-Status des Pi-Scanners an.

Die Next.js-API veröffentlicht Schaltbefehle im MQTT-Thema:

```text
htw/alaa/iot2026/nano-01/commands/alarm
```

Die PWA liest die Nano-Sensordaten verschlüsselt über MQTT/TLS auf Port 8883 aus:

```text
htw/alaa/iot2026/nano-01/telemetry
```

Der Pi 5 verwendet für Telemetrie, Alarmsteuerung und Kontroll-API
`broker.emqx.io:8883` mit dem System-CA-Speicher. Die eigenständige
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
verschlüsselt mit dem öffentlichen MQTT-Broker.
