"""SSE plumbing: ``LISTEN folio_events`` → per-client asyncio queue.

# ponytail: one psycopg connection + daemon thread per SSE client. At the
# spec's 10-user scale that is at most ~10 extra connections; if listener
# count ever hurts, share one LISTEN connection and fan out to all queues.
"""

import json
import threading
from collections.abc import Iterator
from typing import Any

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.models import Book

KEEPALIVE_S = 15.0
NON_TERMINAL_STATUSES = ("uploading", "processing")


def format_frame(payload: dict[str, Any]) -> str:
    """SSE frame: ``event: <kind>`` + ``data: <json>`` (frontend listens per kind)."""
    return f"event: {payload.get('event', 'message')}\ndata: {json.dumps(payload)}\n\n"


def snapshot_frames(session: Session) -> list[str]:
    """One book frame per non-terminal book so a client connecting mid-ingest
    cannot miss the transition (the NOTIFY for it may already have fired)."""
    books = session.scalars(select(Book).where(Book.status.in_(NON_TERMINAL_STATUSES)))
    return [
        format_frame({"event": "book", "book_id": str(book.id), "status": book.status})
        for book in books
    ]


def listen_payloads(conn: psycopg.Connection, stop: threading.Event) -> Iterator[str]:
    """Yield pending NOTIFY payloads until ``stop`` is set.

    ``LISTEN folio_events`` must already be executed on ``conn``; run this on
    the caller's (daemon) thread. The connection is closed by the caller.
    """
    while not stop.is_set():
        for note in conn.notifies(timeout=0.5):
            yield note.payload
