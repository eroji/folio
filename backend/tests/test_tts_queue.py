"""Task B: the segment_audio generation queue — prepare, claim, run, retry."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from mock_tts import SILENT_OPUS
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.db import SessionLocal
from folio.errors import ApiError
from folio.models import Audio, Book, Chapter, Job, Segment, SegmentAudio
from folio.tts import TtsClient, Voice
from folio.tts import queue as queue_module
from folio.tts.cache import cache_key, cache_path
from folio.tts.queue import claim_next_tts, prepare, retry, run_tts_job
from folio.tts.text import normalize_speech_text


def _book(db: Session, *, language: str = "en", chapters: int = 2, per_chapter: int = 2) -> Book:
    book = Book(title="Queue Book", language=language, status="ready")
    db.add(book)
    db.flush()
    for ci in range(chapters):
        chapter = Chapter(book_id=book.id, idx=ci, title=f"Chapter {ci}", char_count=10)
        db.add(chapter)
        db.flush()
        for si in range(per_chapter):
            db.add(
                Segment(
                    chapter_id=chapter.id,
                    idx=si,
                    text=f"Segment text {ci}-{si}.",
                    char_start=0,
                    char_end=10,
                )
            )
    db.commit()
    return book


def _segments(db: Session, book: Book) -> list[Segment]:
    return list(
        db.scalars(
            select(Segment)
            .join(Chapter, Segment.chapter_id == Chapter.id)
            .where(Chapter.book_id == book.id)
            .order_by(Chapter.idx, Segment.idx)
        )
    )


def _rows(db: Session) -> list[SegmentAudio]:
    return list(
        db.scalars(
            select(SegmentAudio)
            .join(Segment, SegmentAudio.segment_id == Segment.id)
            .join(Chapter, Segment.chapter_id == Chapter.id)
            .where(Chapter.book_id.is_not(None))
            .order_by(Chapter.idx, Segment.idx)
        )
    )


def _seed_audio(db: Session, settings: Settings, text: str, voice: str = "ashley-en") -> Audio:
    """Put a clip in the cache the way get_or_synthesize would."""
    key = cache_key(settings.tts_model, voice, settings.tts_format, normalize_speech_text(text))
    path = cache_path(settings, key, settings.tts_format)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(SILENT_OPUS)
    row = Audio(
        cache_key=key,
        path=str(path),
        format=settings.tts_format,
        voice=voice,
        model=settings.tts_model,
        duration_s=1.0,
        bytes=len(SILENT_OPUS),
    )
    db.add(row)
    db.commit()
    return row


class _FakeClient:
    """Stands in for TtsClient in queue tests; swap with a MockTransport one for errors."""

    def __init__(self, _settings: Settings, handler: Any = None) -> None:
        if handler is None:
            self._impl: Any = _Synth()
        else:
            real = TtsClient(_tts_settings())
            real._client = httpx.Client(transport=httpx.MockTransport(handler))
            self._impl = real

    def __enter__(self) -> Any:
        return self._impl

    def __exit__(self, *exc: object) -> None:
        if isinstance(self._impl, TtsClient):
            self._impl.close()

    def synthesize(self, text: str, voice: str) -> tuple[bytes, str]:
        return self._impl.synthesize(text, voice)


class _Synth:
    def synthesize(self, _text: str, _voice: str) -> tuple[bytes, str]:
        return SILENT_OPUS, "opus"


def _tts_settings(**over: Any) -> Settings:
    base: dict[str, Any] = {
        "tts_base_url": "http://tts.test/v1",
        "tts_model": "tts",
        "tts_format": "opus",
        "tts_default_voice": "ashley-en",
    }
    base.update(over)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


def test_prepare_queues_lookahead_window_across_chapter_boundary(
    db: Session, settings: Settings
) -> None:
    book = _book(db)
    segments = _segments(db, book)  # c0s0 c0s1 | c1s0 c1s1
    window = prepare(db, settings, book, segments[1].id, count=2, voice="ashley-en")

    assert [str(s.id) for s, _ in window] == [str(s.id) for s in segments[1:4]]
    assert window[0][0].chapter_id != window[1][0].chapter_id  # crossed into chapter 1
    assert [r.priority for _, r in window] == [10, 100, 100]
    assert all(r.status == "queued" and r.voice == "ashley-en" for _, r in window)


def test_prepare_defaults_count_to_settings_lookahead(db: Session, settings: Settings) -> None:
    book = _book(db, chapters=3, per_chapter=3)
    segments = _segments(db, book)
    window = prepare(db, settings, book, segments[0].id, voice="ashley-en")
    assert len(window) == settings.tts_lookahead + 1


def test_prepare_is_idempotent(db: Session, settings: Settings) -> None:
    book = _book(db)
    start = _segments(db, book)[0].id
    first = prepare(db, settings, book, start, count=2, voice="ashley-en")
    ids = [row.id for _, row in first]
    second = prepare(db, settings, book, start, count=2, voice="ashley-en")

    assert [row.id for _, row in second] == ids  # no duplicate rows
    assert db.scalar(select(func.count()).select_from(SegmentAudio)) == 3
    assert [row.status for _, row in second] == ["queued"] * 3
    assert [row.priority for _, row in second] == [10, 100, 100]
    expected = {
        cache_key("tts", "ashley-en", "opus", normalize_speech_text(s.text)) for s, _ in first
    }
    got = {cache_key("tts", "ashley-en", "opus", normalize_speech_text(s.text)) for s, _ in second}
    assert got == expected  # same cache keys for the same text


def test_prepare_raises_404_for_a_segment_outside_the_book(db: Session, settings: Settings) -> None:
    book = _book(db)
    other = _book(db)
    with pytest.raises(ApiError) as excinfo:
        prepare(db, settings, book, _segments(db, other)[0].id, count=1, voice="ashley-en")
    assert excinfo.value.status == 404


def test_prepare_marks_cache_hits_ready_without_synthesis(db: Session, settings: Settings) -> None:
    book = _book(db)
    segments = _segments(db, book)
    audio = _seed_audio(db, settings, segments[0].text)
    window = prepare(db, settings, book, segments[0].id, count=0, voice="ashley-en")

    segment, row = window[0]
    assert segment.id == segments[0].id
    assert (row.status, row.cache_key) == ("ready", audio.cache_key)
    assert row.error is None


def test_prepare_resolves_voice_by_selection_when_not_given(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        queue_module,
        "discover_voices",
        lambda _s, _c, refresh=False: [Voice(id="ashley-zh", language="zh")],
    )
    book = _book(db, language="zh-TW")
    window = prepare(db, settings, book, _segments(db, book)[0].id, count=0)
    assert {row.voice for _, row in window} == {"ashley-zh"}  # zh-TW -> zh map entry


def test_prepare_raises_priority_of_an_already_queued_segment(
    db: Session, settings: Settings
) -> None:
    book = _book(db)
    segments = _segments(db, book)
    prepare(db, settings, book, segments[0].id, count=1, voice="ashley-en")
    prepare(db, settings, book, segments[1].id, count=0, voice="ashley-en")  # seek onto seg 1

    rows = _rows(db)
    assert [row.priority for row in rows] == [10, 10]  # seg 1 was raised from 100


def test_claim_next_tts_orders_by_priority_and_releases_none_when_empty(
    db: Session, settings: Settings
) -> None:
    book = _book(db, chapters=1, per_chapter=2)
    urgent, later = _segments(db, book)
    prepare(db, settings, book, urgent.id, count=1, voice="ashley-en")

    first = claim_next_tts(db)  # the start segment has priority 10
    assert first is not None and first.segment_id == urgent.id and first.status == "generating"
    second = claim_next_tts(db)
    assert second is not None and second.segment_id == later.id
    assert claim_next_tts(db) is None


def test_concurrent_claims_never_return_the_same_row(db: Session, settings: Settings) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    prepare(db, settings, book, _segments(db, book)[0].id, count=0, voice="ashley-en")
    other = SessionLocal()
    try:
        # Hold the row locked in a second, uncommitted transaction.
        held = (
            other.execute(select(SegmentAudio).with_for_update(skip_locked=True)).scalars().first()
        )
        assert held is not None
        assert claim_next_tts(db) is None  # skipped, not blocked
        other.rollback()
        claimed = claim_next_tts(db)
        assert claimed is not None and claimed.status == "generating"
    finally:
        other.close()


def test_run_tts_job_success_writes_file_audio_row_and_ready(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))

    run_tts_job(db, settings, row)

    assert row.status == "ready" and row.error is None
    audio = db.get(Audio, row.cache_key) if row.cache_key else None
    assert audio is not None and Path(audio.path).is_file()
    assert audio.duration_s == pytest.approx(1.0, abs=0.1)


def test_run_tts_job_after_repeated_5xx_is_failed_never_generating(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("folio.tts.client.time.sleep", lambda _s: None)
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None

    def always_500(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s, always_500))
    run_tts_job(db, settings, row)

    assert row.status == "failed" and row.error
    assert row.status != "generating"
    # retry resets it, and the next run can succeed
    retry(db, settings, segment.id, "ashley-en")
    assert (row.status, row.error, row.priority) == ("queued", None, 10)
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))
    claimed = claim_next_tts(db)
    assert claimed is not None
    run_tts_job(db, settings, claimed)
    assert claimed.status == "ready"


def test_run_tts_job_releases_the_row_on_unexpected_errors(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    prepare(db, settings, book, _segments(db, book)[0].id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None

    class _Boom:
        def synthesize(self, _text: str, _voice: str) -> tuple[bytes, str]:
            raise RuntimeError("boom")

    class _BoomClient:
        def __init__(self, _settings: Settings) -> None:
            self._impl = _Boom()

        def __enter__(self) -> _Boom:
            return self._impl

        def __exit__(self, *exc: object) -> None:
            pass

    monkeypatch.setattr(queue_module, "TtsClient", _BoomClient)
    run_tts_job(db, settings, row)
    assert row.status == "failed" and "boom" in (row.error or "")


def test_retry_without_voice_finds_the_failed_row(db: Session, settings: Settings) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    db.add(SegmentAudio(segment_id=segment.id, voice="ashley-en", status="failed", error="nope"))
    db.commit()
    row = retry(db, settings, segment.id)
    assert (row.status, row.error) == ("queued", None)
    with pytest.raises(ApiError):
        retry(db, settings, segment.id, "ashley-ja")  # no row for that voice


def test_worker_loop_claims_tts_rows_before_ingest_jobs(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))
    book = _book(db, chapters=1, per_chapter=1)
    prepare(db, settings, book, _segments(db, book)[0].id, count=0, voice="ashley-en")
    ingest = Job(type="ingest", book_id=book.id, status="queued")
    db.add(ingest)
    db.commit()

    assert worker.run_once(db, settings) is True

    row = db.scalar(select(SegmentAudio))
    assert row is not None and row.status == "ready"
    db.refresh(ingest)
    assert ingest.status == "queued"  # the ingest job waits for the next iteration
