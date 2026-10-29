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
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response


HOST = os.getenv("CAMERA_RELAY_HOST", "127.0.0.1")
PORT = int(os.getenv("CAMERA_RELAY_PORT", "8766"))
UPLOAD_TOKEN = os.environ["CAMERA_UPLOAD_TOKEN"]
VIEW_TOKEN = os.environ["CAMERA_VIEW_TOKEN"]
MAX_FRAME_BYTES = int(os.getenv("CAMERA_MAX_FRAME_BYTES", "524288"))
MAX_FRAME_AGE_SECONDS = float(os.getenv("CAMERA_MAX_FRAME_AGE_SECONDS", "10"))
WS_HOST = os.getenv("CAMERA_WS_HOST", "127.0.0.1")
WS_PORT = int(os.getenv("CAMERA_WS_PORT", "8767"))

frame_lock = threading.Lock()
latest_frame: bytes | None = None
latest_frame_at = 0.0
ws_loop: asyncio.AbstractEventLoop | None = None
ws_clients: set[ServerConnection] = set()


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
    if parsed.path != "/ws" or expires < now or expires > now + 120:
        return False
    expected = hmac.new(
        VIEW_TOKEN.encode(), f"/ws:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


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
    if parsed.path == "/frame":
        if not authorized(request.headers.get("Authorization"), VIEW_TOKEN):
            return http_response(HTTPStatus.UNAUTHORIZED, b'{"error":"Nicht autorisiert"}', "application/json")
        with frame_lock:
            frame = latest_frame
            frame_age = time.monotonic() - latest_frame_at
        if frame is None or frame_age > MAX_FRAME_AGE_SECONDS:
            return http_response(HTTPStatus.SERVICE_UNAVAILABLE, b'{"error":"Kein aktuelles Kamerabild"}', "application/json")
        return http_response(HTTPStatus.OK, frame, "image/jpeg")
    if not ws_authorized(request.path):
        return http_response(HTTPStatus.UNAUTHORIZED, b"Nicht autorisiert", "text/plain; charset=utf-8")
    return None


async def websocket_handler(connection: ServerConnection) -> None:
    ws_clients.add(connection)
    try:
        with frame_lock:
            frame = latest_frame
            frame_age = time.monotonic() - latest_frame_at
        if frame is not None and frame_age <= MAX_FRAME_AGE_SECONDS:
            await connection.send(frame)
        await connection.wait_closed()
    finally:
        ws_clients.discard(connection)


async def broadcast_frame(frame: bytes) -> None:
    if ws_clients:
        await asyncio.gather(
            *(client.send(frame) for client in tuple(ws_clients)),
            return_exceptions=True,
        )


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
        await asyncio.Future()


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
        global latest_frame, latest_frame_at

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
        if ws_loop is not None:
            asyncio.run_coroutine_threadsafe(broadcast_frame(frame), ws_loop)
        self.send_json(202, {"ok": True, "bytes": len(frame)})


def main() -> None:
    threading.Thread(target=start_websocket_server, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), CameraRelayHandler)
    print(f"Kamera-Relay hört auf http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
