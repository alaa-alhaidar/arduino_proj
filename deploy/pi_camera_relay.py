"""Small authenticated JPEG relay for the Sensor Campus camera node."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import paho.mqtt.client as mqtt
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from pi_fire_detector import FireDetector


HOST = os.getenv("CAMERA_RELAY_HOST", "127.0.0.1")
PORT = int(os.getenv("CAMERA_RELAY_PORT", "8766"))
UPLOAD_TOKEN = os.environ["CAMERA_UPLOAD_TOKEN"]
VIEW_TOKEN = os.environ["CAMERA_VIEW_TOKEN"]
MAX_FRAME_BYTES = int(os.getenv("CAMERA_MAX_FRAME_BYTES", "524288"))
MAX_FRAME_AGE_SECONDS = float(os.getenv("CAMERA_MAX_FRAME_AGE_SECONDS", "10"))
WS_HOST = os.getenv("CAMERA_WS_HOST", "127.0.0.1")
WS_PORT = int(os.getenv("CAMERA_WS_PORT", "8767"))
FIRE_ALARM_STATE_FILE = Path(os.getenv(
    "FIRE_ALARM_STATE_FILE", "/home/alaa/pi-control/fire-alarm.json"
))
MQTT_HOST = os.getenv("MQTT_HOST", "jfa0c01f.ala.eu-central-1.emqxsl.com")
MQTT_PORT = int(os.getenv("MQTT_PORT", "8883"))
MQTT_ALARM_TOPIC = os.getenv(
    "MQTT_ALARM_TOPIC", "htw/alaa/iot2026/nano-01/commands/alarm"
)

frame_lock = threading.Lock()
latest_frame: bytes | None = None
latest_frame_at = 0.0
servo_lock = threading.Lock()
servo_angle = 90
ws_loop: asyncio.AbstractEventLoop | None = None
ws_clients: set[ServerConnection] = set()
ws_ready: set[ServerConnection] = set()
fire_ws_clients: set[ServerConnection] = set()
fire_detector = FireDetector()


def load_fire_alarm() -> tuple[bool, bool]:
    try:
        state = json.loads(FIRE_ALARM_STATE_FILE.read_text(encoding="utf-8"))
        return state.get("latched") is True, state.get("acknowledged") is True
    except (OSError, ValueError, TypeError, AttributeError):
        return False, False


fire_alarm_lock = threading.Lock()
fire_alarm_latched, fire_alarm_acknowledged = load_fire_alarm()


class FireAlarmPublisher:
    def __init__(self) -> None:
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if MQTT_PORT == 8883:
            self.client.tls_set(ca_certs=os.getenv(
                "MQTT_CA_FILE", "/etc/ssl/certs/ca-certificates.crt"
            ))
        if os.getenv("MQTT_USERNAME"):
            self.client.username_pw_set(
                os.environ["MQTT_USERNAME"], os.getenv("MQTT_PASSWORD")
            )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

    def _on_connect(self, client, _userdata, _flags, reason_code, _properties) -> None:
        if reason_code == 0:
            client.subscribe(MQTT_ALARM_TOPIC, qos=1)
            self.publish(fire_alarm_latched)

    def _on_message(self, _client, _userdata, message) -> None:
        try:
            command = json.loads(message.payload.decode("utf-8"))
            if command.get("source") == "fire-ai" and isinstance(command.get("enabled"), bool):
                enabled = command["enabled"]
                store_fire_alarm(enabled, acknowledged=not enabled)
        except (UnicodeError, json.JSONDecodeError, AttributeError):
            pass

    def start(self) -> None:
        self.client.connect_async(MQTT_HOST, MQTT_PORT, 30)
        self.client.loop_start()

    def publish(self, enabled: bool) -> None:
        self.client.publish(
            MQTT_ALARM_TOPIC,
            json.dumps({
                "enabled": enabled,
                "mode": "continuous",
                "source": "fire-ai",
                "request_id": "fire-ai",
            }),
            qos=1,
            retain=True,
        )


fire_alarm_publisher = FireAlarmPublisher()


def store_fire_alarm(enabled: bool, acknowledged: bool | None = None) -> None:
    global fire_alarm_latched, fire_alarm_acknowledged
    with fire_alarm_lock:
        fire_alarm_latched = enabled
        if acknowledged is not None:
            fire_alarm_acknowledged = acknowledged
        FIRE_ALARM_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = FIRE_ALARM_STATE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "latched": enabled,
            "acknowledged": fire_alarm_acknowledged,
        }), encoding="utf-8")
        temporary.replace(FIRE_ALARM_STATE_FILE)


def set_fire_alarm(enabled: bool) -> None:
    store_fire_alarm(enabled, acknowledged=not enabled)
    fire_alarm_publisher.publish(enabled)


def fire_status() -> dict[str, object]:
    status = fire_detector.status()
    with fire_alarm_lock:
        status["latched_alarm"] = fire_alarm_latched
        status["alarm_acknowledged"] = fire_alarm_acknowledged
    return status


def authorized(header: str | None, expected_token: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:], expected_token)


def ws_authorized(path: str) -> bool:
    parsed = urlsplit(path)
    query = parse_qs(parsed.query)
    try:
        expires = int(query.get("expires", [""])[0])
    except ValueError:
        return False
    signature = query.get("signature", [""])[0]
    now = int(time.time())
    if parsed.path not in {"/ws", "/fire/ws"} or expires < now or expires > now + 120:
        return False
    expected = hmac.new(
        VIEW_TOKEN.encode(), f"{parsed.path}:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def servo_command(path: str) -> int | None:
    parsed = urlsplit(path)
    if parsed.path != "/servo":
        return None
    query = parse_qs(parsed.query)
    try:
        angle = int(query.get("angle", [""])[0])
        expires = int(query.get("expires", [""])[0])
    except ValueError:
        return None
    signature = query.get("signature", [""])[0]
    now = int(time.time())
    if angle < 0 or angle > 180 or expires < now or expires > now + 120:
        return None
    expected = hmac.new(
        VIEW_TOKEN.encode(), f"/servo:{angle}:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return angle if hmac.compare_digest(signature, expected) else None


def http_response(status: HTTPStatus, body: bytes, content_type: str) -> Response:
    headers = Headers()
    headers["Content-Type"] = content_type
    headers["Content-Length"] = str(len(body))
    headers["Cache-Control"] = "no-store"
    return Response(status.value, status.phrase, headers, body)


def websocket_request(_connection: ServerConnection, request: Request) -> Response | None:
    parsed = urlsplit(request.path)
    if parsed.path == "/health":
        with frame_lock:
            frame_age = time.monotonic() - latest_frame_at if latest_frame else None
        body = json.dumps({
            "ok": True,
            "frame_available": frame_age is not None,
            "frame_age_seconds": round(frame_age, 3) if frame_age is not None else None,
            "websocket_clients": len(ws_clients),
        }).encode()
        return http_response(HTTPStatus.OK, body, "application/json; charset=utf-8")
    if parsed.path == "/servo":
        angle = servo_command(request.path)
        if angle is None:
            return http_response(HTTPStatus.UNAUTHORIZED, b'{"error":"Nicht autorisiert"}', "application/json")
        global servo_angle
        with servo_lock:
            servo_angle = angle
        body = json.dumps({"ok": True, "angle": servo_angle}).encode()
        return http_response(HTTPStatus.OK, body, "application/json; charset=utf-8")
    if parsed.path == "/frame":
        if not authorized(request.headers.get("Authorization"), VIEW_TOKEN):
            return http_response(HTTPStatus.UNAUTHORIZED, b'{"error":"Nicht autorisiert"}', "application/json")
        with frame_lock:
            frame = latest_frame
            frame_age = time.monotonic() - latest_frame_at
        if frame is None or frame_age > MAX_FRAME_AGE_SECONDS:
            return http_response(HTTPStatus.SERVICE_UNAVAILABLE, b'{"error":"Kein aktuelles Kamerabild"}', "application/json")
        return http_response(HTTPStatus.OK, frame, "image/jpeg")
    if parsed.path == "/fire/status":
        if not authorized(request.headers.get("Authorization"), VIEW_TOKEN):
            return http_response(HTTPStatus.UNAUTHORIZED, b'{"error":"Nicht autorisiert"}', "application/json")
        body = json.dumps(fire_status()).encode()
        return http_response(HTTPStatus.OK, body, "application/json; charset=utf-8")
    if not ws_authorized(request.path):
        return http_response(HTTPStatus.UNAUTHORIZED, b"Nicht autorisiert", "text/plain; charset=utf-8")
    return None


async def websocket_handler(connection: ServerConnection) -> None:
    if urlsplit(connection.request.path).path == "/fire/ws":
        fire_ws_clients.add(connection)
        try:
            await connection.send(json.dumps(fire_status()))
            async for message in connection:
                if message == "acknowledge":
                    set_fire_alarm(False)
                    await connection.send(json.dumps(fire_status()))
        finally:
            fire_ws_clients.discard(connection)
        return

    ws_clients.add(connection)
    try:
        with frame_lock:
            frame = latest_frame
            frame_age = time.monotonic() - latest_frame_at
        if frame is not None and frame_age <= MAX_FRAME_AGE_SECONDS:
            await connection.send(frame)
        else:
            ws_ready.add(connection)
        async for message in connection:
            if message == "next":
                ws_ready.add(connection)
    finally:
        ws_clients.discard(connection)
        ws_ready.discard(connection)


async def broadcast_frame(frame: bytes) -> None:
    clients = tuple(ws_ready)
    if not clients:
        return
    for client in clients:
        ws_ready.discard(client)
    results = await asyncio.gather(
        *(client.send(frame) for client in clients),
        return_exceptions=True,
    )
    for client, result in zip(clients, results):
        if isinstance(result, Exception):
            ws_clients.discard(client)
            ws_ready.discard(client)


async def broadcast_fire_status() -> None:
    last_processed = -1
    while True:
        status = fire_status()
        processed = int(status["frames_processed"])
        if processed != last_processed:
            last_processed = processed
            if status["alarm"] is False and status["alarm_acknowledged"] is True:
                store_fire_alarm(False, acknowledged=False)
                status = fire_status()
            if (status["alarm"] is True and status["latched_alarm"] is False
                    and status["alarm_acknowledged"] is False):
                set_fire_alarm(True)
                status = fire_status()
            elif status["latched_alarm"] is True:
                # Erneut senden, falls ein fremder manueller AUS-Befehl den
                # verriegelten Feueralarm vorübergehend überschrieben hat.
                fire_alarm_publisher.publish(True)
            clients = tuple(fire_ws_clients)
            if clients:
                message = json.dumps(status)
                results = await asyncio.gather(
                    *(client.send(message) for client in clients),
                    return_exceptions=True,
                )
                for client, result in zip(clients, results):
                    if isinstance(result, Exception):
                        fire_ws_clients.discard(client)
        await asyncio.sleep(0.25)


async def run_websocket_server() -> None:
    global ws_loop
    ws_loop = asyncio.get_running_loop()
    async with serve(
        websocket_handler,
        WS_HOST,
        WS_PORT,
        process_request=websocket_request,
        compression=None,
        max_size=MAX_FRAME_BYTES,
    ):
        print(f"Kamera-WebSocket hört auf ws://{WS_HOST}:{WS_PORT}/ws", flush=True)
        status_task = asyncio.create_task(broadcast_fire_status())
        try:
            await asyncio.Future()
        finally:
            status_task.cancel()
            await asyncio.gather(status_task, return_exceptions=True)


def start_websocket_server() -> None:
    asyncio.run(run_websocket_server())


class CameraRelayHandler(BaseHTTPRequestHandler):
    server_version = "SensorCampusCameraRelay/1.0"

    def log_message(self, message: str, *args: object) -> None:
        print(f"{self.address_string()} - {message % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            with frame_lock:
                frame_age = time.monotonic() - latest_frame_at if latest_frame else None
            self.send_json(200, {
                "ok": True,
                "frame_available": frame_age is not None,
                "frame_age_seconds": round(frame_age, 3) if frame_age is not None else None,
            })
            return

        if self.path == "/fire/status":
            if not authorized(self.headers.get("Authorization"), VIEW_TOKEN):
                self.send_json(401, {"error": "Nicht autorisiert"})
                return
            self.send_json(200, fire_status())
            return

        if self.path != "/frame":
            self.send_json(404, {"error": "Nicht gefunden"})
            return
        if not authorized(self.headers.get("Authorization"), VIEW_TOKEN):
            self.send_json(401, {"error": "Nicht autorisiert"})
            return

        with frame_lock:
            frame = latest_frame
            frame_age = time.monotonic() - latest_frame_at
        if frame is None or frame_age > MAX_FRAME_AGE_SECONDS:
            self.send_json(503, {"error": "Kein aktuelles Kamerabild"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(frame)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Frame-Age", f"{frame_age:.3f}")
        self.end_headers()
        self.wfile.write(frame)

    def do_POST(self) -> None:
        global latest_frame, latest_frame_at, servo_angle

        if self.path == "/servo":
            if not authorized(self.headers.get("Authorization"), VIEW_TOKEN):
                self.send_json(401, {"error": "Nicht autorisiert"})
                return
            if self.headers.get_content_type() != "application/json":
                self.send_json(415, {"error": "Content-Type muss application/json sein"})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length < 2 or content_length > 256:
                    raise ValueError
                payload = json.loads(self.rfile.read(content_length))
                requested_angle = int(payload["angle"])
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                self.send_json(400, {"error": "Winkel muss eine ganze Zahl sein"})
                return
            if requested_angle < 0 or requested_angle > 180:
                self.send_json(400, {"error": "Winkel muss zwischen 0 und 180 liegen"})
                return
            with servo_lock:
                servo_angle = requested_angle
            self.send_json(200, {"ok": True, "angle": servo_angle})
            return

        if self.path != "/frame":
            self.send_json(404, {"error": "Nicht gefunden"})
            return
        if not authorized(self.headers.get("Authorization"), UPLOAD_TOKEN):
            self.send_json(401, {"error": "Nicht autorisiert"})
            return
        if self.headers.get_content_type() != "image/jpeg":
            self.send_json(415, {"error": "Content-Type muss image/jpeg sein"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length < 4 or content_length > MAX_FRAME_BYTES:
            self.send_json(413, {"error": "Ungültige Bildgröße"})
            return

        frame = self.rfile.read(content_length)
        if len(frame) != content_length or not frame.startswith(b"\xff\xd8") or not frame.endswith(b"\xff\xd9"):
            self.send_json(400, {"error": "Ungültiges JPEG"})
            return

        with frame_lock:
            latest_frame = frame
            latest_frame_at = time.monotonic()
        fire_detector.submit(frame)
        if ws_loop is not None:
            asyncio.run_coroutine_threadsafe(broadcast_frame(frame), ws_loop)
        with servo_lock:
            current_servo_angle = servo_angle
        self.send_json(202, {
            "ok": True,
            "bytes": len(frame),
            "servo_angle": current_servo_angle,
            "fire": fire_status(),
        })


def main() -> None:
    fire_detector.start()
    fire_alarm_publisher.start()
    threading.Thread(target=start_websocket_server, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), CameraRelayHandler)
    print(f"Kamera-Relay hört auf http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
