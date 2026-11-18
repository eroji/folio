"""The worker runs imports and audio side by side: an upload never waits for
audio generation, and audio someone is waiting for never waits behind a
background chapter prefetch."""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.models import Book, Chapter, Job, Segment, SegmentAudio
from folio.tts import TtsClient


def _segment(db: Session) -> tuple[Segment, Book]:
    book = Book(title="Lanes", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=10)
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text="Hello.", char_start=0, char_end=6)
    db.add(segment)
    db.commit()
    return segment, book


def _wait(condition: Any, seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return False


def test_an_import_and_urgent_audio_run_while_a_background_prefetch_is_busy(
    db: Session, settings: Settings, monkeypatch: Any
) -> None:
    segment, book = _segment(db)
    background_started, release = threading.Event(), threading.Event()
    done: list[str] = []

    def fake_tts(_db: Session, _s: Settings, row: SegmentAudio) -> None:
        if row.voice == "background":
            background_started.set()
            release.wait(10)  # a long chapter prefetch, still running
        row.status = "ready"
        _db.commit()
        done.append(row.voice)

    monkeypatch.setattr(worker, "run_tts_job", fake_tts)
    monkeypatch.setitem(worker.HANDLERS, "ingest", lambda _db, _s, _job: done.append("import"))
    db.add(SegmentAudio(segment_id=segment.id, voice="background", status="queued", priority=900))
    db.commit()

    stop = threading.Event()
    lanes = worker.start_lanes(settings, stop)
    try:
        assert background_started.wait(10)
        # Arrive while the prefetch holds an audio lane.
        db.add(Job(type="ingest", book_id=book.id, status="queued"))
        db.add(SegmentAudio(segment_id=segment.id, voice="urgent", status="queued", priority=10))
        db.commit()
        assert _wait(lambda: {"import", "urgent"} <= set(done)), done
        assert "background" not in done  # both finished while it still ran
    finally:
        release.set()
        stop.set()
        for lane in lanes:
            lane.join(10)
    assert "background" in done
    assert not any(lane.is_alive() for lane in lanes)


def test_tts_requests_across_threads_never_exceed_the_concurrency_cap(settings: Settings) -> None:
    capped = settings.model_copy(
        update={"tts_concurrency": 2, "tts_base_url": "http://cap.test/v1", "tts_format": "mp3"}
    )
    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.05)
        with lock:
            state["active"] -= 1
        return httpx.Response(200, content=b"ID3")

    def speak() -> None:
        client = TtsClient(capped)
        client._client = httpx.Client(transport=httpx.MockTransport(handler))
        for _ in range(3):
            client.synthesize("Hello.", "tess")

    threads = [threading.Thread(target=speak) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert state["peak"] == 2  # 4 threads x 3 requests, never more than the cap at once
