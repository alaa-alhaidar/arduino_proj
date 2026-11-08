"""Shared SQLite event log for Sensor Campus services on the Raspberry Pi."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EVENT_DB = Path(os.getenv(
    "SYSTEM_EVENT_DB", "/home/alaa/pi-control/system-events.sqlite3"
))
MAX_EVENTS = max(100, int(os.getenv("SYSTEM_EVENT_MAX_ROWS", "1000")))


def _connect() -> sqlite3.Connection:
    EVENT_DB.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(EVENT_DB, timeout=5)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA busy_timeout=5000")
    database.execute("""
        CREATE TABLE IF NOT EXISTS system_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            source TEXT NOT NULL,
            severity TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT NOT NULL,
            details_json TEXT
        )
    """)
    database.execute(
        "CREATE INDEX IF NOT EXISTS system_events_time_idx "
        "ON system_events(occurred_at DESC, id DESC)"
    )
    return database


def log_event(
    source: str,
    severity: str,
    event_type: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> None:
    try:
        with _connect() as database:
            database.execute(
                "INSERT INTO system_events "
                "(occurred_at, source, severity, event_type, message, details_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    source,
                    severity,
                    event_type,
                    message,
                    json.dumps(details, separators=(",", ":")) if details else None,
                ),
            )
            database.execute(
                "DELETE FROM system_events WHERE id NOT IN "
                "(SELECT id FROM system_events ORDER BY id DESC LIMIT ?)",
                (MAX_EVENTS,),
            )
    except (OSError, sqlite3.Error) as error:
        print(f"Ereignisprotokoll konnte nicht geschrieben werden: {error}", flush=True)


def recent_events(limit: int = 100) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), 250))
    with _connect() as database:
        database.row_factory = sqlite3.Row
        rows = database.execute(
            "SELECT id, occurred_at, source, severity, event_type, message, details_json "
            "FROM system_events ORDER BY id DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    events = []
    for row in rows:
        event = dict(row)
        raw_details = event.pop("details_json")
        event["details"] = json.loads(raw_details) if raw_details else None
        events.append(event)
    return events
