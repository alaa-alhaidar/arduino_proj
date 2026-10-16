"""Local, token-protected control API for Sensor Campus services on Pi 5."""

import hmac
import json
import os
import socket
import subprocess
import time
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import paho.mqtt.client as mqtt


HOST = os.getenv("PI_CONTROL_HOST", "127.0.0.1")
PORT = int(os.getenv("PI_CONTROL_PORT", "8765"))
TOKEN = os.environ["PI_CONTROL_TOKEN"]
MQTT_SERVICE = "pi-mqtt.service"
SERVICES = ("pi-alarm.service", "pi-telemetry.service")
COMPOSE_FILE = "/home/alaa/network-monitor~/docker/compose-cloud.yaml"
DOCKER_SERVICES = {"postgres", "sync", "pdc"}
TELEMETRY_TOPIC = "iot/v1/nodes/pi-05/telemetry"
ALARM_TOPIC = "iot/v1/nodes/pi-05/commands/alarm"
ALARM_STATE_TOPIC = "iot/v1/nodes/pi-05/state/alarm"


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
        with socket.create_connection(("127.0.0.1", 1883), timeout=2):
            return True
    except OSError:
        return False


def docker_services_running():
    result = subprocess.run(
        ["docker", "compose", "-f", COMPOSE_FILE, "--profile", "pdc",
         "ps", "--status", "running", "--services"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return DOCKER_SERVICES.issubset(set(result.stdout.splitlines()))


def current_status():
    services = {service: service_state(service) for service in SERVICES}
    mqtt = mqtt_available()
    docker = docker_services_running()
    return {
        "running": all(state == "active" for state in services.values()) and mqtt and docker,
        "mqtt": "active" if mqtt_available() else "unavailable",
        "docker": "active" if docker else "incomplete",
        "services": services,
    }


def receive_telemetry():
    received = threading.Event()
    result = {}
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def on_connect(connected, userdata, flags, reason_code, properties):
        connected.subscribe(TELEMETRY_TOPIC, qos=1)

    def on_message(connected, userdata, message):
        try:
            result["payload"] = json.loads(message.payload.decode("utf-8"))
            received.set()
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect("127.0.0.1", 1883, 10)
    client.loop_start()
    try:
        if not received.wait(7):
            raise TimeoutError("Keine MQTT-Sensordaten")
        return result["payload"]
    finally:
        client.disconnect()
        client.loop_stop()


def publish_alarm(enabled):
    request_id = str(uuid.uuid4())
    confirmed = threading.Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def on_connect(connected, userdata, flags, reason_code, properties):
        connected.subscribe(ALARM_STATE_TOPIC, qos=1)
        connected.publish(ALARM_TOPIC, json.dumps({
            "enabled": enabled,
            "request_id": request_id,
        }), qos=1, retain=False)

    def on_message(connected, userdata, message):
        try:
            state = json.loads(message.payload.decode("utf-8"))
            if state.get("request_id") == request_id and state.get("enabled") is enabled:
                confirmed.set()
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect("127.0.0.1", 1883, 10)
    client.loop_start()
    try:
        if not confirmed.wait(7):
            raise TimeoutError("Alarmbefehl wurde nicht bestätigt")
    finally:
        client.disconnect()
        client.loop_stop()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, f"Bearer {TOKEN}")

    def reject_unauthorized(self):
        self.send_json(401, {"error": "Nicht autorisiert"})

    def do_GET(self):
        if not self.authorized():
            return self.reject_unauthorized()
        if self.path == "/status":
            return self.send_json(200, current_status())
        if self.path == "/telemetry":
            try:
                return self.send_json(200, receive_telemetry())
            except (OSError, TimeoutError) as error:
                return self.send_json(503, {"error": str(error)})
        return self.send_json(404, {"error": "Nicht gefunden"})

    def do_POST(self):
        if not self.authorized():
            return self.reject_unauthorized()
        if self.path == "/alarm":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                enabled = body["enabled"]
                if not isinstance(enabled, bool):
                    raise ValueError("enabled muss ein Boolean sein")
                publish_alarm(enabled)
                return self.send_json(200, {"ok": True, "enabled": enabled})
            except (KeyError, ValueError, json.JSONDecodeError) as error:
                return self.send_json(400, {"error": str(error)})
            except (OSError, TimeoutError) as error:
                return self.send_json(503, {"error": str(error)})

        actions = {"/start": "start", "/stop": "stop"}
        action = actions.get(self.path)
        if action is None:
            return self.send_json(404, {"error": "Nicht gefunden"})
        try:
            if action == "start":
                subprocess.run(
                    ["docker", "compose", "-f", COMPOSE_FILE, "--profile", "pdc",
                     "up", "-d", "postgres", "sync", "pdc"],
                    timeout=60,
                    check=True,
                )
                if not mqtt_available():
                    subprocess.run(
                        ["systemctl", "--user", "start", MQTT_SERVICE],
                        timeout=10,
                        check=True,
                    )
                subprocess.run(
                    ["systemctl", "--user", "start", *SERVICES],
                    timeout=20,
                    check=True,
                )
            else:
                subprocess.run(
                    ["systemctl", "--user", "stop", *SERVICES, MQTT_SERVICE],
                    timeout=20,
                    check=True,
                )
                subprocess.run(
                    ["docker", "compose", "-f", COMPOSE_FILE, "--profile", "pdc",
                     "stop", "pdc", "sync", "postgres"],
                    timeout=60,
                    check=True,
                )
        except (subprocess.SubprocessError, OSError) as error:
            return self.send_json(500, {"error": f"Dienstaktion fehlgeschlagen: {error}"})
        status = current_status()
        if action == "start":
            for _ in range(10):
                if status["running"]:
                    break
                time.sleep(0.5)
                status = current_status()
        if action == "start" and status["mqtt"] != "active":
            return self.send_json(503, {**status, "error": "MQTT-Broker ist nicht erreichbar"})
        self.send_json(200, status)

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"Pi control API auf http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
