# Sensor Campus PWA

Eine einfache Next.js-PWA zur Anzeige von Sensorwerten und zur Steuerung der LED-/Buzzer-Alarmschaltung auf einem Raspberry Pi 5 über MQTT.

## Lokal starten

```bash
npm install
cp .env.example .env.local
npm run dev
```

Danach ist die Oberfläche unter `http://localhost:3000` erreichbar.

Die Next.js-API veröffentlicht Schaltbefehle im MQTT-Thema:

```text
iot/v1/nodes/pi-05/commands/alarm
```

Wenn Next.js auf dem Mac läuft, verwendet die Beispielkonfiguration den vorhandenen SSH-Tunnel auf Port `18830`.
