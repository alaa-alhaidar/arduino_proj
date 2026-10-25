"""Relay retained Nano telemetry from the public broker to EMQX Cloud."""

import os
import signal
import time

import paho.mqtt.client as mqtt


SOURCE_HOST = os.getenv("MQTT_SOURCE_HOST", "broker.emqx.io")
SOURCE_PORT = int(os.getenv("MQTT_SOURCE_PORT", "8883"))
TARGET_HOST = os.environ["MQTT_HOST"]
TARGET_PORT = int(os.getenv("MQTT_PORT", "8883"))
CA_FILE = os.getenv("MQTT_CA_FILE", "/etc/ssl/certs/ca-certificates.crt")
TOPIC = os.getenv("MQTT_TELEMETRY_TOPIC", "htw/alaa/iot2026/nano-01/telemetry")
FORWARD_INTERVAL_SECONDS = int(os.getenv("MQTT_FORWARD_INTERVAL_SECONDS", "60"))


def make_client(client_id: str) -> mqtt.Client:
    instance = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    instance.tls_set(ca_certs=CA_FILE)
    instance.reconnect_delay_set(min_delay=1, max_delay=30)
    return instance


target = make_client("sensor-campus-pi05-cloud-target")
target.username_pw_set(os.environ["MQTT_USERNAME"], os.environ["MQTT_PASSWORD"])
source = make_client("sensor-campus-pi05-public-source")
last_forwarded_at = 0.0


def on_target_connect(_client, _userdata, _flags, reason_code, _properties):
    print(f"Cloud-Broker verbunden: {reason_code}", flush=True)


def on_source_connect(connected, _userdata, _flags, reason_code, _properties):
    if reason_code == 0:
        connected.subscribe(TOPIC, qos=1)
        print(f"Öffentlichen Topic abonniert: {TOPIC}", flush=True)
    else:
        print(f"Öffentliche MQTT-Verbindung fehlgeschlagen: {reason_code}", flush=True)


def on_message(_client, _userdata, message):
    global last_forwarded_at
    now = time.monotonic()
    if now - last_forwarded_at < FORWARD_INTERVAL_SECONDS:
        return
    result = target.publish(TOPIC, message.payload, qos=1, retain=True)
    if result.rc == mqtt.MQTT_ERR_SUCCESS:
        last_forwarded_at = now
    else:
        print(f"Telemetrie-Weiterleitung fehlgeschlagen: {result.rc}", flush=True)


target.on_connect = on_target_connect
source.on_connect = on_source_connect
source.on_message = on_message
target.connect(TARGET_HOST, TARGET_PORT, 30)
source.connect(SOURCE_HOST, SOURCE_PORT, 30)
target.loop_start()
source.loop_start()

running = True


def stop(_signum, _frame):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while running:
    time.sleep(1)

source.disconnect()
target.disconnect()
source.loop_stop()
target.loop_stop()
