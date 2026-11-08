"""Receive PWA alarm commands and switch the Pi alarm GPIO."""

import json
import math
import os
import signal
import sqlite3
import sys
from contextlib import closing
import threading
from datetime import datetime, timezone
from pathlib import Path
import time

import paho.mqtt.client as mqtt
from gpiozero import DigitalOutputDevice
from gpiozero.pins.lgpio import LGPIOFactory

sys.path.insert(0, "/home/alaa/pi-control")
from pi_event_log import log_event


MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_CA_FILE = os.getenv("MQTT_CA_FILE")
ALARM_TOPIC = os.getenv("MQTT_ALARM_TOPIC", "iot/v1/nodes/pi-05/commands/alarm")
STATE_TOPIC = os.getenv("MQTT_ALARM_STATE_TOPIC", "iot/v1/nodes/pi-05/state/alarm")
TELEMETRY_TOPIC = os.getenv("MQTT_TELEMETRY_TOPIC", "iot/v1/nodes/pi-05/telemetry")
STATE_FILE = Path(os.getenv(
    "PWA_ALARM_STATE_FILE",
    "/home/alaa/network-monitor~/data/pwa-alarm.json",
))
TOLERANCE_FILE = Path(os.getenv(
    "TOLERANCE_FILE",
    "/home/alaa/pi-control/tolerance.json",
))
DOS_GUARD_STATE_FILE = Path(os.getenv(
    "DOS_GUARD_STATE_FILE",
    "/home/alaa/pi-control/dos-guard-state.json",
))
ALARM_MUTE_FILE = Path(os.getenv(
    "ALARM_MUTE_FILE",
    "/home/alaa/pi-control/alarm-mute.json",
))
MONITOR_DB = Path(os.getenv("MONITOR_DB", str(STATE_FILE.parent / "monitor.sqlite3")))
NETWORK_CHECK_INTERVAL = 5
SECURITY_CHECK_INTERVAL = 1

TOLERANCE_PERCENT = float(os.getenv("TOLERANCE_PERCENT", "5"))  # Nur Migration alter Konfigurationen.
ALARM_PIN = int(os.getenv("ALARM_PIN", "27"))
STATUS_LED_PIN = int(os.getenv("STATUS_LED_PIN", "22"))
TELEMETRY_TIMEOUT_SECONDS = float(os.getenv("TELEMETRY_TIMEOUT_SECONDS", "600"))
ALARM_ACTIVE_HIGH = os.getenv("ALARM_ACTIVE_HIGH", "true").lower() not in {
    "0", "false", "no", "off",
}

# Raspberry Pi 5 GPIO is handled by lgpio. The alarm always starts switched off.
pin_factory = LGPIOFactory()
alarm = DigitalOutputDevice(
    ALARM_PIN,
    active_high=ALARM_ACTIVE_HIGH,
    initial_value=False,
    pin_factory=pin_factory,
)
status_led = DigitalOutputDevice(
    STATUS_LED_PIN,
    active_high=True,
    initial_value=True,
    pin_factory=pin_factory,
)
status_timer = None
network_timer = None
security_timer = None
alarm_signalling = False
alarm_output_mode = "off"
network_alarm_active = False
security_alarm_active = False
security_alarm_status = "offline"
hardware_muted = False
offline_sensors = []
sensor_states = None
last_measurement_at = None
status_lock = threading.RLock()
status_stopping = False
measurement_timeout_active = False
ranges = None
manual_alarm_active = False
manual_alarm_continuous = False
fire_alarm_active = False
automatic_alarm_active = False
automatic_alarm_acknowledged = False
outside_measurements = []


def alarm_signature():
    return json.dumps({
        "security_status": security_alarm_status,
        "network_alarm": network_alarm_active,
        "offline_sensors": offline_sensors,
        "measurement_timeout": measurement_timeout_active,
        "manual_alarm": manual_alarm_active,
        "fire_alarm": fire_alarm_active,
        "automatic_alarm": automatic_alarm_active,
        "outside_measurements": outside_measurements,
    }, sort_keys=True, separators=(",", ":"))


def limits_are_valid(values):
    required = (
        "temperature_c", "pressure_hpa", "humidity_pct", "gas_resistance_ohm",
    )
    if not isinstance(values, dict) or set(values) != set(required):
        return False
    for key in required:
        limits = values.get(key)
        if not isinstance(limits, dict):
            return False
        minimum, maximum = limits.get("min"), limits.get("max")
        if (not isinstance(minimum, (int, float)) or isinstance(minimum, bool)
                or not isinstance(maximum, (int, float)) or isinstance(maximum, bool)
                or not math.isfinite(minimum) or not math.isfinite(maximum)
                or minimum >= maximum):
            return False
    return True


def ranges_from_setpoints(values):
    if not isinstance(values, dict) or not telemetry_is_valid({"measurements": values}):
        return None
    factor = TOLERANCE_PERCENT / 100
    return {
        key: {"min": value - abs(value) * factor,
              "max": value + abs(value) * factor}
        for key, value in values.items()
    }


def load_ranges():
    try:
        saved = json.loads(TOLERANCE_FILE.read_text(encoding="utf-8"))
        values = saved.get("ranges")
        if limits_are_valid(values):
            return values
        return ranges_from_setpoints(saved.get("setpoints"))
    except (OSError, ValueError, TypeError):
        pass
    return None


def write_tolerance_state():
    with status_lock:
        TOLERANCE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = TOLERANCE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "ranges": ranges,
            "automatic_alarm": automatic_alarm_active,
            "automatic_alarm_acknowledged": automatic_alarm_acknowledged,
            "manual_alarm": manual_alarm_active,
            "fire_alarm": fire_alarm_active,
            "measurement_timeout": measurement_timeout_active,
            "network_alarm": network_alarm_active,
            "security_alarm": security_alarm_active,
            "security_status": security_alarm_status,
            "hardware_muted": hardware_muted,
            "alarm_output_mode": alarm_output_mode,
            "alarm_signature": alarm_signature(),
            "offline_sensors": offline_sensors,
            "alarm_active": security_alarm_active or network_alarm_active or measurement_timeout_active or manual_alarm_active or fire_alarm_active or (
                automatic_alarm_active and not automatic_alarm_acknowledged
            ),
            "outside_measurements": outside_measurements,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }), encoding="utf-8")
        temporary.replace(TOLERANCE_FILE)


def set_hardware_mute(muted):
    global hardware_muted
    hardware_muted = muted
    if muted:
        ALARM_MUTE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = ALARM_MUTE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "muted": True,
            "alarm_signature": alarm_signature(),
        }), encoding="utf-8")
        temporary.replace(ALARM_MUTE_FILE)
    else:
        ALARM_MUTE_FILE.unlink(missing_ok=True)


def update_alarm_output():
    global alarm_signalling, alarm_output_mode
    with status_lock:
        if status_stopping:
            return
        alarm_active = not hardware_muted and (
            security_alarm_active or network_alarm_active
            or measurement_timeout_active or manual_alarm_active or fire_alarm_active
            or (automatic_alarm_active and not automatic_alarm_acknowledged)
        )
        desired_mode = (
            "continuous" if alarm_active and fire_alarm_active
            else "pulse" if alarm_active
            else "off"
        )
        if desired_mode == alarm_output_mode:
            return
        alarm.off()
        if desired_mode == "continuous":
            alarm.on()
        elif desired_mode == "pulse":
            alarm.blink(on_time=0.2, off_time=2.0, background=True)
        alarm_output_mode = desired_mode
        alarm_signalling = desired_mode != "off"


def load_sensor_states(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=0.5)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'devices', 'registered_sensors'} <= tables:
            return []
        return [
            {'ip': ip, 'name': name, 'online': bool(online) and ping != 'keine Antwort'}
            for ip, name, online, ping in db.execute(
                "SELECT r.ip,r.name,COALESCE(d.online,0),d.ping "
                "FROM registered_sensors r LEFT JOIN devices d ON d.ip=r.ip "
                "WHERE r.enabled=1 ORDER BY r.ip"
            )
        ]


def check_network_alarm():
    global network_timer, network_alarm_active, offline_sensors, sensor_states
    try:
        current_states = load_sensor_states(MONITOR_DB)
    except (OSError, sqlite3.Error):
        current_states = None  # A transient read failure must not clear an active offline alarm.
    with status_lock:
        if status_stopping:
            return
        if current_states is not None:
            previous = {
                item['ip']: item['online'] for item in sensor_states or []
            }
            for sensor in current_states:
                if sensor_states is None or previous.get(sensor['ip']) != sensor['online']:
                    state = "online" if sensor['online'] else "offline"
                    log_event(
                        "sensor",
                        "info" if sensor['online'] else "warning",
                        f"sensor_{state}",
                        f"{sensor['name']} ist {state}",
                        {'ip': sensor['ip'], 'name': sensor['name']},
                    )
            current_offline = [
                {'ip': item['ip'], 'name': item['name']}
                for item in current_states if not item['online']
            ]
            changed = current_offline != offline_sensors
            sensor_states = current_states
            offline_sensors = current_offline
            network_alarm_active = bool(current_offline)
            update_alarm_output()
            if changed:
                write_tolerance_state()
        network_timer = threading.Timer(NETWORK_CHECK_INTERVAL, check_network_alarm)
        network_timer.daemon = True
        network_timer.start()


def check_security_alarm():
    global security_timer, security_alarm_active, security_alarm_status, hardware_muted
    try:
        state = json.loads(DOS_GUARD_STATE_FILE.read_text(encoding="utf-8"))
        current_status = state.get("status", "offline")
        if not isinstance(current_status, str):
            raise ValueError("Ungültiger Sicherheitsstatus")
        current_active = current_status in {"warning", "attack", "blocked"}
    except (OSError, ValueError, TypeError, AttributeError):
        current_status = None
        current_active = None
    try:
        mute_state = json.loads(ALARM_MUTE_FILE.read_text(encoding="utf-8"))
        requested_mute = mute_state.get("muted") is True
        muted_signature = mute_state.get("alarm_signature")
    except (OSError, ValueError, TypeError, AttributeError):
        requested_mute, muted_signature = False, None
    with status_lock:
        if status_stopping:
            return
        if current_active is not None:
            security_changed = (current_active != security_alarm_active
                                or current_status != security_alarm_status)
            security_alarm_active = current_active
            security_alarm_status = current_status
            current_signature = alarm_signature()
            if requested_mute and muted_signature != current_signature:
                requested_mute = False
                try:
                    ALARM_MUTE_FILE.unlink(missing_ok=True)
                except OSError:
                    pass
            changed = security_changed or requested_mute != hardware_muted
            hardware_muted = requested_mute
            update_alarm_output()
            if changed:
                write_tolerance_state()
                print(
                    "DoS-Hardwarealarm: " + (current_status.upper() if current_active else "AUS"),
                    flush=True,
                )
        security_timer = threading.Timer(SECURITY_CHECK_INTERVAL, check_security_alarm)
        security_timer.daemon = True
        security_timer.start()


def telemetry_is_valid(payload):
    """Complete measurements count as data flow, including temporary fake data."""
    measurements = payload.get("measurements")
    if not isinstance(measurements, dict):
        return False
    required = (
        "temperature_c", "pressure_hpa", "humidity_pct", "gas_resistance_ohm",
    )
    return all(
        isinstance(measurements.get(key), (int, float))
        and not isinstance(measurements.get(key), bool)
        and math.isfinite(measurements[key])
        for key in required
    )


def switch_status_led_off():
    global status_timer, measurement_timeout_active
    with status_lock:
        if status_stopping:
            return
        remaining = TELEMETRY_TIMEOUT_SECONDS - (time.monotonic() - last_measurement_at) if last_measurement_at is not None else 0
        if remaining > 0:
            # An older cancelled timer may already be running when a new reading arrives.
            status_timer = threading.Timer(remaining, switch_status_led_off)
            status_timer.daemon = True
            status_timer.start()
            return
        status_timer = None
        status_led.off()
        measurement_timeout_active = True
        update_alarm_output()
        write_tolerance_state()


def start_measurement_watchdog():
    global last_measurement_at, status_timer
    with status_lock:
        last_measurement_at = time.monotonic()
        status_led.on()
        status_timer = threading.Timer(TELEMETRY_TIMEOUT_SECONDS, switch_status_led_off)
        status_timer.daemon = True
        status_timer.start()


def stop_status_led():
    global status_stopping, alarm_signalling, alarm_output_mode
    with status_lock:
        status_stopping = True
        alarm.off()
        alarm_signalling = False
        alarm_output_mode = "off"
        if status_timer is not None:
            status_timer.cancel()
        if network_timer is not None:
            network_timer.cancel()
        if security_timer is not None:
            security_timer.cancel()
        status_led.off()


def handle_telemetry(message):
    global status_timer, last_measurement_at, ranges, automatic_alarm_active
    global automatic_alarm_acknowledged, outside_measurements, measurement_timeout_active
    try:
        payload = json.loads(message.payload.decode("utf-8"))
        healthy = not message.retain and telemetry_is_valid(payload)
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        healthy = False

    if not healthy:
        # Invalid or retained messages are not fresh measurements and do not clear the grace period.
        return
    if healthy:
        with status_lock:
            if status_stopping:
                return
            was_timed_out = measurement_timeout_active
            measurement_timeout_active = False
            last_measurement_at = time.monotonic()
            if status_timer is not None:
                status_timer.cancel()
            status_led.on()
            status_timer = threading.Timer(TELEMETRY_TIMEOUT_SECONDS, switch_status_led_off)
            status_timer.daemon = True
            status_timer.start()
        measurements = payload["measurements"]
        configured_ranges = load_ranges()
        if configured_ranges is not None:
            ranges = configured_ranges
        created_ranges = False
        if ranges is None:
            ranges = ranges_from_setpoints(measurements)
            created_ranges = True
            print("Startbereiche aus Messwerten erzeugt; in der Kontrolloberfläche anpassen", flush=True)
        outside = [
            key for key, value in measurements.items()
            if key in ranges
            and not (ranges[key]["min"] <= value <= ranges[key]["max"])
        ]
        changed = outside != outside_measurements
        outside_measurements = outside
        automatic_alarm_active = bool(outside)
        if not automatic_alarm_active:
            automatic_alarm_acknowledged = False
        update_alarm_output()
        if changed or was_timed_out or created_ranges or not TOLERANCE_FILE.exists():
            write_tolerance_state()
            print(
                "Automatischer Alarm: " + (", ".join(outside) if outside else "AUS"),
                flush=True,
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
        client.subscribe([(ALARM_TOPIC, 1), (TELEMETRY_TOPIC, 1)])
        print("Warte auf PWA-Befehle und Sensordaten", flush=True)
    else:
        print("MQTT-Verbindung abgelehnt:", reason_code, flush=True)


def on_message(client, userdata, message):
    global manual_alarm_active, manual_alarm_continuous
    global fire_alarm_active, automatic_alarm_acknowledged
    if message.topic == TELEMETRY_TOPIC:
        handle_telemetry(message)
        return
    try:
        command = json.loads(message.payload.decode("utf-8"))
        enabled = command["enabled"]
        if not isinstance(enabled, bool):
            raise TypeError("enabled muss true oder false sein")
        fire_command = command.get("source") == "fire-ai"
        if fire_command:
            fire_alarm_active = enabled
        else:
            manual_alarm_active = enabled
            manual_alarm_continuous = enabled and command.get("mode") == "continuous"
            if enabled:
                automatic_alarm_acknowledged = False
                set_hardware_mute(False)
            elif automatic_alarm_active:
                automatic_alarm_acknowledged = True
            if not enabled and command.get("mute_all") is True:
                set_hardware_mute(True)
        update_alarm_output()
        write_tolerance_state()
        write_state(enabled)
        publish_confirmation(client, enabled, command.get("request_id"))
        print(
            "KI-Feueralarm:" if fire_command else "PWA-Alarm:",
            "EIN" if enabled else "AUS",
            flush=True,
        )
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        print("Ungültiger MQTT-Befehl ignoriert:", error, flush=True)


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
if MQTT_CA_FILE:
    client.tls_set(ca_certs=MQTT_CA_FILE)
if os.getenv("MQTT_USERNAME"):
    client.username_pw_set(os.environ["MQTT_USERNAME"], os.getenv("MQTT_PASSWORD"))
client.on_connect = on_connect
client.on_message = on_message
ranges = load_ranges()


def stop_cleanly(signum, frame):
    """Switch both outputs off before systemd terminates the service."""
    stop_status_led()
    alarm.off()
    client.disconnect()


signal.signal(signal.SIGTERM, stop_cleanly)
signal.signal(signal.SIGINT, stop_cleanly)
start_measurement_watchdog()
check_network_alarm()
check_security_alarm()
client.connect_async(MQTT_HOST, MQTT_PORT, 30)
try:
    client.loop_forever(retry_first_connection=True)
finally:
    stop_status_led()
    alarm.off()
    status_led.close()
    alarm.close()
    pin_factory.close()
