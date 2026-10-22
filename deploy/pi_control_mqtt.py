"""Token-protected MQTT control worker for the Sensor Campus Pi 5."""

import hmac
import json
import os
import socket
import sqlite3
import subprocess

import paho.mqtt.client as mqtt


TOKEN = os.environ["PI_CONTROL_TOKEN"]
MQTT_HOST = os.getenv("PUBLIC_MQTT_HOST", "broker.emqx.io")
MQTT_PORT = int(os.getenv("PUBLIC_MQTT_PORT", "8883"))
MQTT_CA_FILE = os.getenv("PUBLIC_MQTT_CA_FILE", "/etc/ssl/certs/ca-certificates.crt")
COMMAND_TOPIC = os.getenv(
    "MQTT_PI_CONTROL_TOPIC", "htw/alaa/iot2026/pi-05/commands/control"
)
STATE_TOPIC = os.getenv(
    "MQTT_PI_CONTROL_STATE_TOPIC", "htw/alaa/iot2026/pi-05/state/control"
)
SERVICES = ("pi-alarm.service", "pi-telemetry.service")
MONITOR_DB = os.getenv("MONITOR_DB", "/home/alaa/network-monitor~/data/monitor.sqlite3")
TOLERANCE_FILE = os.getenv("TOLERANCE_FILE", "/home/alaa/pi-control/tolerance.json")


def service_state(service):
    result = subprocess.run(
        ["systemctl", "--user", "is-active", service],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def mqtt_available():
    try:
        with socket.create_connection((MQTT_HOST, MQTT_PORT), timeout=3):
            return True
    except OSError:
        return False


def current_status():
    services = {service: service_state(service) for service in SERVICES}
    broker_available = mqtt_available()
    return {
        "running": broker_available and all(
            state == "active" for state in services.values()
        ),
        "mqtt": "active" if broker_available else "unavailable",
        "broker": f"{MQTT_HOST}:{MQTT_PORT} (TLS)",
        "services": services,
    }


def connected_devices():
    with sqlite3.connect(MONITOR_DB, timeout=5) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute("""
            SELECT registered.ip, registered.name, devices.hostname,
                   COALESCE(devices.online, 0) AS online, devices.last_checked
            FROM registered_sensors AS registered
            LEFT JOIN devices ON devices.ip = registered.ip
            WHERE registered.enabled = 1
            ORDER BY registered.ip
        """).fetchall()
    return {"devices": [dict(row) for row in rows]}


def alarm_state():
    with open(TOLERANCE_FILE, encoding="utf-8") as state_file:
        state = json.load(state_file)
    if not isinstance(state, dict):
        raise ValueError("Ungültiger Alarmstatus")
    return state


def control_services(action):
    result = subprocess.run(
        ["systemctl", "--user", action, *SERVICES],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Dienstesteuerung fehlgeschlagen")
    return current_status()


def handle_command(client, payload):
    request_id = payload.get("request_id")
    if not isinstance(request_id, str):
        return
    supplied_token = payload.get("token")
    if not isinstance(supplied_token, str) or not hmac.compare_digest(supplied_token, TOKEN):
        response = {"request_id": request_id, "ok": False, "error": "Nicht autorisiert"}
    else:
        try:
            action = payload.get("action")
            if action == "status":
                data = current_status()
            elif action == "devices":
                data = connected_devices()
            elif action == "alarm_state":
                data = alarm_state()
            elif action in {"start", "stop"}:
                data = control_services(action)
            else:
                raise ValueError("Ungültige Aktion")
            response = {"request_id": request_id, "ok": True, "data": data}
        except (OSError, sqlite3.Error, subprocess.SubprocessError, RuntimeError, ValueError) as error:
            response = {"request_id": request_id, "ok": False, "error": str(error)}
    client.publish(STATE_TOPIC, json.dumps(response), qos=1, retain=False)


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.tls_set(ca_certs=MQTT_CA_FILE)
    if os.getenv("MQTT_USERNAME"):
        client.username_pw_set(os.environ["MQTT_USERNAME"], os.getenv("MQTT_PASSWORD"))

    def on_connect(connected, userdata, flags, reason_code, properties):
        if reason_code == 0:
            connected.subscribe(COMMAND_TOPIC, qos=1)
            print(f"MQTT-Steuerung hört auf {COMMAND_TOPIC}", flush=True)
        else:
            print(f"MQTT-Verbindung fehlgeschlagen: {reason_code}", flush=True)

    def on_message(connected, userdata, message):
        try:
            payload = json.loads(message.payload.decode("utf-8"))
            if isinstance(payload, dict):
                handle_command(connected, payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT, 30)
    client.loop_forever()


if __name__ == "__main__":
    main()
