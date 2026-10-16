"""Receive PWA alarm commands and switch the Pi alarm GPIO."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
import time

import paho.mqtt.client as mqtt
from gpiozero import DigitalOutputDevice
from gpiozero.pins.lgpio import LGPIOFactory


MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
ALARM_TOPIC = os.getenv("MQTT_ALARM_TOPIC", "iot/v1/nodes/pi-05/commands/alarm")
STATE_TOPIC = os.getenv("MQTT_ALARM_STATE_TOPIC", "iot/v1/nodes/pi-05/state/alarm")
STATE_FILE = Path(os.getenv(
    "PWA_ALARM_STATE_FILE",
    "/home/alaa/network-monitor~/data/pwa-alarm.json",
))
ALARM_PIN = int(os.getenv("ALARM_PIN", "27"))
ALARM_ACTIVE_HIGH = os.getenv("ALARM_ACTIVE_HIGH", "true").lower() not in {
    "0", "false", "no", "off",
}

# Raspberry Pi 5 GPIO is handled by lgpio. The alarm always starts switched off.
alarm = DigitalOutputDevice(
    ALARM_PIN,
    active_high=ALARM_ACTIVE_HIGH,
    initial_value=False,
    pin_factory=LGPIOFactory(),
)


def write_state(enabled):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "enabled": bool(enabled),
        "command_id": time.time_ns(),
    }), encoding="utf-8")
    temporary.replace(STATE_FILE)


def publish_confirmation(client, enabled, request_id):
    client.publish(STATE_TOPIC, json.dumps({
        "enabled": enabled,
        "request_id": request_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }), qos=1, retain=True)


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        client.subscribe(ALARM_TOPIC, qos=1)
        print("Warte auf PWA-Befehle:", ALARM_TOPIC, flush=True)
    else:
        print("MQTT-Verbindung abgelehnt:", reason_code, flush=True)


def on_message(client, userdata, message):
    try:
        command = json.loads(message.payload.decode("utf-8"))
        enabled = command["enabled"]
        if not isinstance(enabled, bool):
            raise TypeError("enabled muss true oder false sein")
        if enabled:
            alarm.on()
        else:
            alarm.off()
        write_state(enabled)
        publish_confirmation(client, enabled, command.get("request_id"))
        print("PWA-Alarm:", "EIN" if enabled else "AUS", flush=True)
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        print("Ungültiger MQTT-Befehl ignoriert:", error, flush=True)


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.on_connect = on_connect
client.on_message = on_message
client.connect(MQTT_HOST, MQTT_PORT, 30)
try:
    client.loop_forever()
finally:
    alarm.off()
    alarm.close()
