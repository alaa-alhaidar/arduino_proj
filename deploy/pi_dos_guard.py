"""Controlled DoS-demo detector and mitigator for the Sensor Campus Pi 5.

The service exposes a small HTTP endpoint on a dedicated lab port.  It counts
requests per source IP in a sliding time window, publishes its state via MQTT,
and can temporarily block an offending source *on that demo port only*.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import signal
import subprocess
import time
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Deque

import paho.mqtt.client as mqtt

from pi_event_log import log_event


LISTEN_HOST = os.getenv("DOS_GUARD_HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("DOS_GUARD_PORT", "8088"))
WINDOW_SECONDS = float(os.getenv("DOS_GUARD_WINDOW_SECONDS", "10"))
REQUEST_THRESHOLD = int(os.getenv("DOS_GUARD_REQUEST_THRESHOLD", "80"))
BLOCK_SECONDS = int(os.getenv("DOS_GUARD_BLOCK_SECONDS", "60"))
MAX_REQUEST_BYTES = int(os.getenv("DOS_GUARD_MAX_REQUEST_BYTES", "8192"))
ENFORCEMENT_ENABLED = os.getenv("DOS_GUARD_ENFORCE", "false").lower() in {
    "1", "true", "yes", "on"
}
ALLOWED_NETWORKS = tuple(
    ipaddress.ip_network(value.strip(), strict=False)
    for value in os.getenv("DOS_GUARD_ALLOW", "127.0.0.0/8,::1/128").split(",")
    if value.strip()
)

MQTT_HOST = os.getenv(
    "PUBLIC_MQTT_HOST", "jfa0c01f.ala.eu-central-1.emqxsl.com"
)
MQTT_PORT = int(os.getenv("PUBLIC_MQTT_PORT", "8883"))
MQTT_CA_FILE = os.getenv(
    "PUBLIC_MQTT_CA_FILE", "/etc/ssl/certs/ca-certificates.crt"
)
MQTT_TOPIC = os.getenv(
    "MQTT_DOS_GUARD_TOPIC", "htw/alaa/iot2026/pi-05/security/dos"
)
STATE_FILE = Path(os.getenv(
    "DOS_GUARD_STATE_FILE", "/home/alaa/pi-control/dos-guard-state.json"
))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_allowed(address: str) -> bool:
    parsed = ipaddress.ip_address(address)
    return any(parsed in network for network in ALLOWED_NETWORKS)


@dataclass
class GuardState:
    status: str = "normal"
    requests_in_window: int = 0
    threshold: int = REQUEST_THRESHOLD
    window_seconds: float = WINDOW_SECONDS
    source_ip: str | None = None
    blocked_until: str | None = None
    mitigation: str = "observe"
    total_requests: int = 0
    updated_at: str = ""


class Firewall:
    """Adds removable, port-scoped iptables rules without invoking a shell."""

    def __init__(self, port: int, enabled: bool) -> None:
        self.port = port
        self.enabled = enabled
        self.blocked: set[str] = set()

    def _rule(self, action: str, address: str) -> list[str]:
        family = ipaddress.ip_address(address).version
        executable = "iptables" if family == 4 else "ip6tables"
        return [
            executable, action, "INPUT", "-s", address, "-p", "tcp",
            "--dport", str(self.port), "-m", "comment", "--comment",
            "sensor-campus-dos-demo", "-j", "DROP",
        ]

    def block(self, address: str) -> bool:
        if not self.enabled or address in self.blocked:
            return False
        result = subprocess.run(
            self._rule("-I", address), capture_output=True, text=True,
            timeout=5, check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Firewall-Regel fehlgeschlagen")
        self.blocked.add(address)
        return True

    def unblock(self, address: str) -> None:
        if address not in self.blocked:
            return
        subprocess.run(
            self._rule("-D", address), capture_output=True, text=True,
            timeout=5, check=False,
        )
        self.blocked.discard(address)

    def clear(self) -> None:
        for address in tuple(self.blocked):
            self.unblock(address)


class DosGuard:
    def __init__(self) -> None:
        if WINDOW_SECONDS <= 0 or REQUEST_THRESHOLD <= 0 or BLOCK_SECONDS <= 0:
            raise ValueError("Zeitfenster, Schwellwert und Sperrdauer müssen positiv sein")
        self.events: dict[str, Deque[float]] = defaultdict(deque)
        self.blocked_until: dict[str, float] = {}
        self.state = GuardState(
            mitigation="armed" if ENFORCEMENT_ENABLED else "observe",
            updated_at=utc_now(),
        )
        self.last_publish = 0.0
        self.last_logged_status: str | None = None
        self.firewall = Firewall(LISTEN_PORT, ENFORCEMENT_ENABLED)
        self.mqtt = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        self.mqtt.tls_set(ca_certs=MQTT_CA_FILE)
        if os.getenv("MQTT_USERNAME"):
            self.mqtt.username_pw_set(
                os.environ["MQTT_USERNAME"], os.getenv("MQTT_PASSWORD")
            )

    def publish(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_publish < 1:
            return
        self.last_publish = now
        self.state.updated_at = utc_now()
        if self.state.status != self.last_logged_status:
            severity = (
                "critical" if self.state.status in {"attack", "blocked"}
                else "warning" if self.state.status == "warning"
                else "info"
            )
            log_event(
                "dos",
                severity,
                f"dos_{self.state.status}",
                f"DoS-Guard Status: {self.state.status}",
                {
                    "source_ip": self.state.source_ip,
                    "requests_in_window": self.state.requests_in_window,
                    "threshold": self.state.threshold,
                    "mitigation": self.state.mitigation,
                },
            )
            self.last_logged_status = self.state.status
        payload = json.dumps(asdict(self.state), separators=(",", ":"))
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary = STATE_FILE.with_suffix(".tmp")
            temporary.write_text(payload, encoding="utf-8")
            temporary.replace(STATE_FILE)
        except OSError as error:
            print(f"Lokaler Status konnte nicht geschrieben werden: {error}", flush=True)
        self.mqtt.publish(
            MQTT_TOPIC,
            payload,
            qos=1,
            retain=True,
        )

    def start_mqtt(self) -> None:
        self.mqtt.connect_async(MQTT_HOST, MQTT_PORT, 30)
        self.mqtt.loop_start()
        self.publish(force=True)

    def stop(self) -> None:
        self.firewall.clear()
        self.state.status = "offline"
        self.state.requests_in_window = 0
        self.state.source_ip = None
        self.state.blocked_until = None
        self.publish(force=True)
        self.mqtt.loop_stop()
        self.mqtt.disconnect()

    async def expire_block(self, address: str, deadline: float) -> None:
        await asyncio.sleep(max(0, deadline - time.monotonic()))
        if self.blocked_until.get(address) != deadline:
            return
        self.firewall.unblock(address)
        self.blocked_until.pop(address, None)
        self.events.pop(address, None)
        if self.state.source_ip == address:
            self.state = GuardState(
                mitigation="armed" if ENFORCEMENT_ENABLED else "observe",
                total_requests=self.state.total_requests,
                updated_at=utc_now(),
            )
            self.publish(force=True)

    def register(self, address: str) -> tuple[int, bool]:
        now = time.monotonic()
        events = self.events[address]
        while events and events[0] <= now - WINDOW_SECONDS:
            events.popleft()
        events.append(now)
        count = len(events)
        self.state.total_requests += 1
        self.state.requests_in_window = count
        self.state.source_ip = address

        if count < REQUEST_THRESHOLD or is_allowed(address):
            self.state.status = "warning" if count >= REQUEST_THRESHOLD * 0.7 else "normal"
            self.publish()
            return count, False

        existing_deadline = self.blocked_until.get(address)
        if existing_deadline is not None and existing_deadline > now:
            self.state.status = "blocked" if address in self.firewall.blocked else "attack"
            self.publish()
            return count, True

        deadline = now + BLOCK_SECONDS
        self.blocked_until[address] = deadline
        try:
            blocked = self.firewall.block(address)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            blocked = False
            print(f"Firewall-Abwehr fehlgeschlagen: {error}", flush=True)
        self.state.status = "blocked" if blocked else "attack"
        self.state.blocked_until = datetime.fromtimestamp(
            time.time() + BLOCK_SECONDS, timezone.utc
        ).isoformat(timespec="seconds")
        self.state.mitigation = "blocked" if blocked else "observe"
        self.publish(force=True)
        asyncio.create_task(self.expire_block(address, deadline))
        return count, True

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer = writer.get_extra_info("peername")
        address = str(peer[0]) if peer else "0.0.0.0"
        try:
            await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=2)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            pass

        count, attack = self.register(address)
        status = "attack" if attack else "ok"
        body = json.dumps({
            "service": "sensor-campus-dos-demo",
            "status": status,
            "requests_in_window": count,
            "threshold": REQUEST_THRESHOLD,
        }).encode("utf-8")
        code = b"429 Too Many Requests" if attack else b"200 OK"
        writer.write(
            b"HTTP/1.1 " + code + b"\r\nContent-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        try:
            await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


async def main() -> None:
    guard = DosGuard()
    guard.start_mqtt()
    server = await asyncio.start_server(
        guard.handle, LISTEN_HOST, LISTEN_PORT, limit=MAX_REQUEST_BYTES
    )
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for received_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(received_signal, stop_event.set)

    print(
        f"DoS-Guard hört auf {LISTEN_HOST}:{LISTEN_PORT}; "
        f"Schwellwert={REQUEST_THRESHOLD}/{WINDOW_SECONDS:g}s; "
        f"Abwehr={'aktiv' if ENFORCEMENT_ENABLED else 'Beobachtung'}",
        flush=True,
    )
    try:
        async with server:
            await stop_event.wait()
    finally:
        guard.stop()


if __name__ == "__main__":
    asyncio.run(main())
