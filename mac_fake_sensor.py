import json
import math
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone

import paho.mqtt.client as mqtt


PI_HOST = os.getenv("PI_HOST", "192.168.178.128")
PI_USER = os.getenv("PI_USER", "alaa")
LOCAL_MQTT_PORT = int(os.getenv("LOCAL_MQTT_PORT", "18830"))
REMOTE_MQTT_PORT = int(os.getenv("REMOTE_MQTT_PORT", "1883"))
TOPIC = "iot/v1/nodes/lab-01/telemetry"

# Demo: Nach 30 Sekunden folgen drei auffällige Messungen. Danach werden wieder
# Normalwerte gesendet. Der Zyklus wiederholt sich alle 90 Sekunden.
DEMO_ALARM_ENABLED = os.getenv("DEMO_ALARM_ENABLED", "1") == "1"
DEMO_CYCLE_LENGTH = 18
DEMO_ALARM_START = 6
DEMO_ALARM_DURATION = 3

stop_event = threading.Event()
mqtt_connected = threading.Event()
tunnel_process = None


def run_ssh_tunnel():
    """Keep an SSH tunnel alive and recreate it after a network outage."""
    global tunnel_process

    command = [
        "ssh",
        "-N",
        "-L",
        f"127.0.0.1:{LOCAL_MQTT_PORT}:127.0.0.1:{REMOTE_MQTT_PORT}",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        f"{PI_USER}@{PI_HOST}",
    ]

    while not stop_event.is_set():
        print(f"SSH-Tunnel zu {PI_USER}@{PI_HOST} wird aufgebaut ...")
        tunnel_process = subprocess.Popen(command)

        while tunnel_process.poll() is None and not stop_event.wait(1):
            pass

        if tunnel_process.poll() is None:
            tunnel_process.terminate()
            try:
                tunnel_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                tunnel_process.kill()

        if not stop_event.is_set():
            mqtt_connected.clear()
            print("SSH-Tunnel getrennt. Neuer Versuch in 3 Sekunden ...")
            stop_event.wait(3)


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        mqtt_connected.set()
        print("MQTT verbunden. Sensordaten werden gesendet.")
    else:
        mqtt_connected.clear()
        print(f"MQTT-Verbindung abgelehnt: {reason_code}")


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    mqtt_connected.clear()
    if not stop_event.is_set():
        print("MQTT getrennt. Warte auf WLAN und automatische Wiederverbindung ...")


def is_demo_alarm(sequence):
    cycle_position = sequence % DEMO_CYCLE_LENGTH
    return (
        DEMO_ALARM_ENABLED
        and DEMO_ALARM_START
        <= cycle_position
        < DEMO_ALARM_START + DEMO_ALARM_DURATION
    )


def build_message(boot_id, sequence):
    phase = sequence / 12
    measurements = {
        "temperature_c": round(23 + 2 * math.sin(phase), 2),
        "pressure_hpa": round(1013 + 3 * math.sin(phase / 3), 2),
        "humidity_pct": round(48 + 5 * math.cos(phase), 2),
        "gas_resistance_ohm": round(120000 + 10000 * math.sin(phase / 2)),
    }

    if is_demo_alarm(sequence):
        # Deutlich außerhalb eines typischen zulässigen Innenraumbereichs.
        measurements["temperature_c"] = 42.5
        measurements["humidity_pct"] = 82.0

    return {
        "schema_version": 1,
        "node_id": "lab-01",
        "boot_id": boot_id,
        "sequence": sequence,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "source": "fake",
        "measurements": measurements,
    }


def main():
    tunnel_thread = threading.Thread(target=run_ssh_tunnel, daemon=True)
    tunnel_thread.start()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.reconnect_delay_set(min_delay=1, max_delay=10)
    client.connect_async("127.0.0.1", LOCAL_MQTT_PORT, 15)
    client.loop_start()

    boot_id = str(uuid.uuid4())
    sequence = 0

    try:
        while not stop_event.is_set():
            if not mqtt_connected.wait(timeout=1):
                continue

            message = build_message(boot_id, sequence)
            result = client.publish(TOPIC, json.dumps(message), qos=1, retain=False)

            try:
                result.wait_for_publish(timeout=10)
            except (RuntimeError, ValueError):
                mqtt_connected.clear()

            if result.is_published():
                prefix = "DEMO-ALARM:" if is_demo_alarm(sequence) else "Normalwerte:"
                print(prefix, message["measurements"])
                sequence += 1
                stop_event.wait(5)
            else:
                print("Senden nicht bestätigt. Automatischer neuer Versuch ...")
                mqtt_connected.clear()
                stop_event.wait(2)

    except KeyboardInterrupt:
        print("Sender beendet.")
    finally:
        stop_event.set()
        client.disconnect()
        client.loop_stop()
        if tunnel_process is not None and tunnel_process.poll() is None:
            tunnel_process.terminate()
        tunnel_thread.join(timeout=4)


if __name__ == "__main__":
    main()
