"""Live start: a narrator change mid-play streams the new voice from the
listener's sentence at once, instead of waiting ~35 s for a whole-segment clip
(fish-s2 streams raw PCM; ffmpeg encodes it to the clip format on the fly), and
the same generation becomes the segment's cached clip."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from mock_tts import BODIES, CONFIG
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.db import SessionLocal
from folio.integrations import Integrations, TtsServer, save_integrations
from folio.models import Audio, Book, Chapter, Segment, SegmentAudio
from folio.tts.adts import adts_duration
from folio.tts.queue import cancel_pending, claim_next_tts, prepare
from folio.tts.text import normalize_speech_text
from folio.tts.voices import reset_voice_cache

VOICE = "ashley-en"
TEXT = (
    "The first sentence walks along the harbour wall tonight. "
    "The second sentence watches the boats come slowly home. "
    "The third sentence ends the evening with a quiet song."
)
NORMALIZED = normalize_speech_text(TEXT)
THIRD = NORMALIZED.index("The third")
SECONDS_PER_CHAR = 0.01  # mock_tts.PCM_SECONDS_PER_CHAR


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


@pytest.fixture()
def live(auth_client: httpx.AsyncClient, db: Session, mock_tts: str) -> Any:
    """The admin TTS server is the mock, and clips are AAC (as in production)."""
    reset_voice_cache()
    save_integrations(db, Integrations(tts=TtsServer(base_url=f"{mock_tts}/v1")))
    db.commit()
    app = auth_client._transport.app  # type: ignore[attr-defined]
    settings = get_settings().model_copy(update={"tts_format": "aac"})
    app.dependency_overrides[get_settings] = lambda: settings
    yield settings
    app.dependency_overrides.pop(get_settings, None)


def _segment(db: Session) -> tuple[Book, Segment]:
    book = Book(title="Live Book", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=len(TEXT))
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text=TEXT, char_start=0, char_end=len(TEXT))
    db.add(segment)
    db.commit()
    return book, segment


async def _start(
    client: httpx.AsyncClient, book: Book, segment: Segment, at: float
) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/books/{book.id}/audio/live",
        json={"segment_id": str(segment.id), "at": at, "voice": VOICE},
        headers=csrf(client),
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _rows(db: Session, segment: Segment) -> list[SegmentAudio]:
    db.expire_all()
    return list(db.scalars(select(SegmentAudio).where(SegmentAudio.segment_id == segment.id)))


def _wait(db: Session, segment: Segment, status: str | None) -> list[SegmentAudio]:
    """The clip is finished in the background after the stream ends."""
    deadline = time.monotonic() + 10
    while True:
        rows = _rows(db, segment)
        if (status is None and not rows) or (rows and rows[0].status == status):
            return rows
        assert time.monotonic() < deadline, [r.status for r in rows]
        time.sleep(0.05)


async def test_a_segment_with_no_clip_streams_from_the_listeners_sentence(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    book, segment = _segment(db)

    body = await _start(auth_client, book, segment, at=0.7)  # inside sentence three

    assert body["status"] == "streaming" and body["voice"] == VOICE
    assert body["from"] == pytest.approx(THIRD / len(NORMALIZED), abs=1e-6)
    stream = await auth_client.get(body["url"])
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("audio/aac")
    assert stream.headers["x-accel-buffering"] == "no"  # nginx passes it through as made
    tail_seconds = len(NORMALIZED[THIRD:]) * SECONDS_PER_CHAR
    assert adts_duration(stream.content) == pytest.approx(tail_seconds, abs=0.15)
    # The engine streamed only the rest of the segment, as PCM.
    assert {k: BODIES[0][k] for k in ("input", "response_format", "stream", "voice")} == {
        "input": NORMALIZED[THIRD:],
        "response_format": "pcm",
        "stream": True,
        "voice": VOICE,
    }

    # Then the start of the segment once, and the whole is the cached clip.
    (row,) = _wait(db, segment, "ready")
    head = NORMALIZED[:THIRD].strip()
    assert [(b["input"], bool(b.get("stream"))) for b in BODIES[1:]] == [(head, True)]
    audio = db.get(Audio, row.cache_key)
    assert audio is not None and Path(audio.path).is_file()
    head_seconds = len(head) * SECONDS_PER_CHAR
    assert audio.duration_s == pytest.approx(head_seconds + tail_seconds, abs=0.15)
    assert audio.marks is not None and audio.marks[0] == [0.0, 0.0]
    assert audio.marks[1][0] == pytest.approx(body["from"], abs=1e-6)
    assert audio.marks[1][1] == pytest.approx(head_seconds, abs=0.05)
    # The next prepare finds the clip: nothing is generated twice.
    count = len(BODIES)
    window = prepare(db, live, book, segment.id, count=0, voice=VOICE)
    assert (window[0][1].status, window[0][1].cache_key) == ("ready", row.cache_key)
    assert len(BODIES) == count


async def test_from_the_first_sentence_there_is_no_separate_start(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    book, segment = _segment(db)
    body = await _start(auth_client, book, segment, at=0.0)
    assert body["from"] == 0.0
    await auth_client.get(body["url"])
    (row,) = _wait(db, segment, "ready")
    assert [b["input"] for b in BODIES] == [NORMALIZED]
    audio = db.get(Audio, row.cache_key)
    assert audio is not None and audio.marks is None


async def test_a_segment_already_made_needs_no_live_start(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    book, segment = _segment(db)
    first = await _start(auth_client, book, segment, at=0.0)
    await auth_client.get(first["url"])
    _wait(db, segment, "ready")
    count = len(BODIES)

    again = await _start(auth_client, book, segment, at=0.5)

    assert again == {"status": "ready", "voice": VOICE}
    assert len(BODIES) == count


async def test_a_second_request_joins_the_start_already_running(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    """Safari probes a media URL more than once; two players may switch together."""
    CONFIG["stream_delay_s"] = 0.02
    book, segment = _segment(db)
    first = await _start(auth_client, book, segment, at=0.7)
    second = await _start(auth_client, book, segment, at=0.7)
    assert second["url"] == first["url"]
    a = await auth_client.get(first["url"])
    b = await auth_client.get(second["url"])
    assert a.content == b.content and a.content  # each GET gets the stream from its start
    _wait(db, segment, "ready")
    assert sum(1 for body in BODIES if body["input"] == NORMALIZED[THIRD:]) == 1


async def test_an_engine_that_cannot_stream_pcm_leaves_the_segment_to_the_queue(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    CONFIG["reject_pcm"] = True
    book, segment = _segment(db)

    body = await _start(auth_client, book, segment, at=0.7)

    assert body == {"status": "unavailable", "voice": VOICE}
    (row,) = _rows(db, segment)
    assert row.status == "queued"  # the worker makes it the usual way


async def test_a_format_ffmpeg_does_not_stream_here_is_unavailable(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    app = auth_client._transport.app  # type: ignore[attr-defined]
    opus = live.model_copy(update={"tts_format": "opus"})
    app.dependency_overrides[get_settings] = lambda: opus
    book, segment = _segment(db)

    body = await _start(auth_client, book, segment, at=0.7)

    assert body["status"] == "unavailable"
    assert BODIES == []


async def test_a_narrator_change_stops_a_live_start(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    CONFIG["stream_delay_s"] = 0.1  # ~1.6 s of streaming
    book, segment = _segment(db)
    body = await _start(auth_client, book, segment, at=0.0)

    cancel_pending(db, book.id, "sarah")
    stream = await auth_client.get(body["url"])

    full = len(NORMALIZED) * SECONDS_PER_CHAR
    assert adts_duration(stream.content) < full - 0.5  # cut short, not played out
    _wait(db, segment, None)
    assert db.scalars(select(Audio)).all() == []
    assert len(BODIES) == 1  # the start of the segment was never asked for


async def test_a_narrator_change_stops_a_live_start_the_engine_has_not_answered_yet(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    """A busy engine queues the request; the live start must hang up anyway,
    or the abandoned request keeps its place ahead of the new voice."""
    import threading

    CONFIG["first_delay_s"] = 3.0
    book, segment = _segment(db)

    def change_narrator() -> None:
        with SessionLocal() as other:
            cancel_pending(other, book.id, "sarah")

    threading.Timer(0.5, change_narrator).start()
    started = time.monotonic()
    await _start(auth_client, book, segment, at=0.0)

    assert time.monotonic() - started < 2  # hung up at once, not after the engine's 3 s
    _wait(db, segment, None)
    assert db.scalars(select(Audio)).all() == []


async def test_a_live_start_takes_over_a_segment_the_worker_is_generating(
    auth_client: httpx.AsyncClient, db: Session, live: Settings
) -> None:
    """The listener is waiting now; the worker's whole-segment request would
    keep them in silence for its full length. Deleting its row stops it."""
    book, segment = _segment(db)
    worker_row = SegmentAudio(segment_id=segment.id, voice=VOICE, status="generating", priority=10)
    db.add(worker_row)
    db.commit()
    worker_id = worker_row.id

    body = await _start(auth_client, book, segment, at=0.0)

    assert body["status"] == "streaming"
    rows = _rows(db, segment)
    assert [r.id for r in rows] != [worker_id]
    await auth_client.get(body["url"])
    _wait(db, segment, "ready")


async def test_a_live_stream_needs_a_session_and_a_known_id(
    client: httpx.AsyncClient, auth_client: httpx.AsyncClient, live: Settings
) -> None:
    assert (await auth_client.get("/api/v1/audio/live/" + "0" * 32)).status_code == 404
    client.cookies.clear()
    assert (await client.get("/api/v1/audio/live/" + "0" * 32)).status_code == 401


def test_the_worker_takes_over_an_abandoned_live_start(db: Session, settings: Settings) -> None:
    """The API process died mid-stream: its claim must not block the segment forever."""
    _book, segment = _segment(db)
    row = SegmentAudio(segment_id=segment.id, voice=VOICE, status="streaming", priority=10)
    db.add(row)
    db.commit()
    assert claim_next_tts(db) is None  # a running live start is left alone

    row.updated_at = datetime.now(UTC) - timedelta(minutes=10)
    db.commit()
    claimed = claim_next_tts(db)
    assert claimed is not None and claimed.id == row.id and claimed.status == "generating"


def test_prepare_keeps_and_a_narrator_change_drops_a_live_claim(
    db: Session, settings: Settings
) -> None:
    book, segment = _segment(db)
    db.add(SegmentAudio(segment_id=segment.id, voice=VOICE, status="streaming", priority=10))
    db.commit()
    window = prepare(db, settings, book, segment.id, count=0, voice=VOICE)
    assert window[0][1].status == "streaming"
    assert cancel_pending(db, book.id, "sarah") == 1
