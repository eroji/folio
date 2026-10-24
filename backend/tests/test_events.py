"""Task 8: SSE frames — unit tests for formatting/snapshot, one real end-to-end stream."""

from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import uvicorn
from sqlalchemy.orm import Session

from folio.db import SessionLocal
from folio.events import format_frame, snapshot_frames
from folio.jobs import notify
from folio.main import create_app
from folio.models import Book, User
from folio.models import Session as SessionRow


def test_format_frame() -> None:
    frame = format_frame({"event": "job", "job_id": "j1", "book_id": None, "status": "done"})
    assert frame.startswith("event: job\ndata: ")
    assert frame.endswith("\n\n")
    assert json.loads(frame.split("data: ", 1)[1])["status"] == "done"


def test_snapshot_frames_only_non_terminal(db: Session) -> None:
    db.add_all(
        [
            Book(title="Up", status="uploading"),
            Book(title="Proc", status="processing"),
            Book(title="Done", status="ready"),
            Book(title="Dead", status="failed"),
        ]
    )
    db.commit()
    frames = snapshot_frames(db)
    statuses = [json.loads(f.split("data: ", 1)[1])["status"] for f in frames]
    assert sorted(statuses) == ["processing", "uploading"]
    assert all(f.startswith("event: book\n") for f in frames)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _sse_frames(lines: Iterator[str]) -> Iterator[dict[str, object]]:
    """Pair ``event:``/``data:`` lines into frames; skip keepalive comments."""
    event = ""
    for line in lines:
        if line.startswith(":"):
            continue
        if line.startswith("event: "):
            event = line[len("event: ") :]
        elif line.startswith("data: ") and event:
            frame = json.loads(line[len("data: ") :])
            yield frame
            event = ""


def test_sse_snapshot_and_live_frames(db: Session) -> None:
    """Real uvicorn server, real LISTEN: snapshot frame first, then a live job frame."""
    book = Book(title="Mid ingest", status="processing")
    user = User(ldap_dn="uid=sse,dc=test", username="sse", role="user")
    db.add_all([book, user])
    db.flush()
    token = uuid.uuid4().hex
    db.add(
        SessionRow(
            id=token,
            user_id=user.id,
            csrf_token="x" * 64,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
    )
    db.commit()

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    try:
        with (
            httpx.Client(timeout=60) as client,
            client.stream(
                "GET",
                f"http://127.0.0.1:{port}/api/v1/events",
                headers={"Cookie": f"folio_session={token}"},
            ) as response,
        ):
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            frames = _sse_frames(response.iter_lines())
            snapshot = next(frames)  # generous timeouts: CI boxes are slow
            assert snapshot == {"event": "book", "book_id": str(book.id), "status": "processing"}
            s = SessionLocal()
            try:
                notify(
                    s,
                    {
                        "event": "job",
                        "job_id": str(uuid.uuid4()),
                        "book_id": str(book.id),
                        "status": "done",
                    },
                )
            finally:
                s.close()
            live = next(frames)
            assert live["event"] == "job" and live["book_id"] == str(book.id)
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        assert not thread.is_alive()


async def test_events_requires_session(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/events")
    assert response.status_code == 401
