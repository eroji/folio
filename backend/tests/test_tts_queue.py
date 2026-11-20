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
from folio.tts.narration import narration_prompt
from folio.tts.queue import claim_next_tts, prepare, retry, run_tts_job
from folio.tts.text import normalize_speech_text
from folio.voice_catalog import save_voice_instructions


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


def _seed_audio(
    db: Session, settings: Settings, text: str, voice: str = "ashley-en", genre: str | None = None
) -> Audio:
    """Put a clip in the cache the way get_or_synthesize would."""
    key = cache_key(
        settings.tts_model,
        voice,
        settings.tts_format,
        normalize_speech_text(text),
        narration_prompt(db, voice, genre),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
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

    def __init__(self, _settings: Settings, handler: Any = None, synth: Any = None) -> None:
        if handler is not None:
            real = TtsClient(_tts_settings())
            real._client = httpx.Client(transport=httpx.MockTransport(handler))
            self._impl = real
        else:
            self._impl = synth or _Synth()

    def __enter__(self) -> Any:
        return self._impl

    def __exit__(self, *exc: object) -> None:
        if isinstance(self._impl, TtsClient):
            self._impl.close()

    def synthesize(
        self, text: str, voice: str, instructions: str | None = None
    ) -> tuple[bytes, str]:
        return self._impl.synthesize(text, voice, instructions)


class _Synth:
    def __init__(self, captured: list[str | None] | None = None) -> None:
        self.captured = captured if captured is not None else []

    def list_voices(self) -> list[Voice]:
        return []  # no engine list: prepare trusts the requested voice

    def synthesize(
        self, _text: str, _voice: str, instructions: str | None = None
    ) -> tuple[bytes, str]:
        self.captured.append(instructions)
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
    assert [r.priority for _, r in window] == [10, 101, 102]
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
    assert [row.priority for _, row in second] == [10, 101, 102]
    endpoint = (settings.tts_base_url or "").rstrip("/")
    expected = {
        cache_key("tts", "ashley-en", "opus", normalize_speech_text(s.text), endpoint=endpoint)
        for s, _ in first
    }
    got = {
        cache_key("tts", "ashley-en", "opus", normalize_speech_text(s.text), endpoint=endpoint)
        for s, _ in second
    }
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


def test_prepare_ignores_a_requested_voice_the_engine_does_not_list(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stale pin from a previous TTS server must not be handed to the engine:
    it would synthesize with whatever the engine substitutes and cache the clip
    under the wrong id. ``ashley-en`` (the en map entry) is not on the engine,
    so the fallback lands on the first English engine voice."""
    monkeypatch.setattr(
        queue_module,
        "discover_voices",
        lambda _s, _c, refresh=False: [Voice(id="tess", language="en")],
    )
    book = _book(db)
    window = prepare(db, settings, book, _segments(db, book)[0].id, count=1, voice="jack-en")
    assert {row.voice for _, row in window} == {"tess"}


def test_prepare_honours_a_requested_voice_the_engine_lists(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        queue_module,
        "discover_voices",
        lambda _s, _c, refresh=False: [Voice(id="tess", language="en")],
    )
    book = _book(db)
    window = prepare(db, settings, book, _segments(db, book)[0].id, count=1, voice="tess")
    assert {row.voice for _, row in window} == {"tess"}


def test_prepare_raises_priority_of_an_already_queued_segment(
    db: Session, settings: Settings
) -> None:
    book = _book(db)
    segments = _segments(db, book)
    prepare(db, settings, book, segments[0].id, count=1, voice="ashley-en")
    prepare(db, settings, book, segments[1].id, count=0, voice="ashley-en")  # seek onto seg 1

    rows = _rows(db)
    assert [row.priority for row in rows] == [10, 10]  # seg 1 was raised from 101


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


def test_claim_next_tts_generates_a_prepared_window_in_reading_order(
    db: Session, settings: Settings
) -> None:
    """One prepare writes every row in one transaction, so created_at ties and
    the random UUID used to decide: a prefetched chapter was synthesized in
    random order, and playback stalled at almost every boundary."""
    book = _book(db, chapters=3, per_chapter=4)
    segments = _segments(db, book)
    prepare(db, settings, book, segments[0].id, count=len(segments) - 1, voice="ashley-en")

    claimed = []
    while (row := claim_next_tts(db)) is not None:
        claimed.append(row.segment_id)
    assert claimed == [s.id for s in segments]


def test_a_later_prepare_pulls_its_window_ahead_of_the_far_lookahead(
    db: Session, settings: Settings
) -> None:
    book = _book(db, chapters=3, per_chapter=4)
    segments = _segments(db, book)
    prepare(db, settings, book, segments[0].id, count=len(segments) - 1, voice="ashley-en")
    for _ in range(6):
        claim_next_tts(db)  # segments 0-5 were generated while the listener played
    # The listener skipped ahead past the queue to segment 9.
    prepare(db, settings, book, segments[9].id, count=2, voice="ashley-en")

    claimed = []
    while (row := claim_next_tts(db)) is not None:
        claimed.append(row.segment_id)
    # 9 is needed now, then its own lookahead, then the rest of the earlier window.
    assert claimed == [s.id for s in (segments[9], segments[10], segments[11], *segments[6:9])]


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


def test_run_tts_job_survives_row_deleted_mid_synthesis(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A chapter/rule change can delete the row while TTS runs; the worker must
    survive the stale UPDATE instead of crashing the whole process."""
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))

    db.delete(row)
    db.commit()

    run_tts_job(db, settings, row)  # must not raise StaleDataError


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
        def synthesize(
            self, _text: str, _voice: str, _instructions: str | None = None
        ) -> tuple[bytes, str]:
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


def test_worker_runs_an_import_before_background_prefetch(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A whole-chapter prefetch (~100 segments, ~1000 sentence requests) kept an
    upload "processing" until it drained: only audio someone is waiting for
    (the playing segment and the lookahead window) goes before imports."""
    calls: list[str] = []
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))
    monkeypatch.setattr(
        worker, "run_tts_job", lambda _db, _s, row: calls.append(f"tts {row.priority}")
    )
    monkeypatch.setitem(worker.HANDLERS, "ingest", lambda _db, _s, _job: calls.append("ingest"))
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    far = settings.tts_lookahead + 30  # a segment deep in a chapter prefetch
    db.add(SegmentAudio(segment_id=segment.id, voice="far", status="queued", priority=100 + far))
    db.add(SegmentAudio(segment_id=segment.id, voice="now", status="queued", priority=10))
    db.add(Job(type="ingest", book_id=book.id, status="queued"))
    db.commit()

    for _ in range(3):
        assert worker.run_once(db, settings) is True
        db.commit()

    assert calls == ["tts 10", "ingest", f"tts {100 + far}"]


def test_prepare_notifies_only_when_the_window_changes(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Idempotent prepares must not emit SSE frames: the player re-prepares on
    every audio frame, so notifying unchanged state is a request flood."""
    book = _book(db)
    segments = _segments(db, book)
    frames: list[dict[str, Any]] = []
    monkeypatch.setattr(queue_module, "notify", lambda _db, payload: frames.append(payload))

    prepare(db, settings, book, segments[0].id, count=1)
    assert frames  # the first prepare queues the window
    frames.clear()

    prepare(db, settings, book, segments[0].id, count=1)
    assert frames == []  # nothing changed, nothing announced


def test_prepare_requeues_when_the_voice_instruction_changes(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A narration instruction is part of the cache key: changing it turns the
    ready clip into a miss and the row goes back to queued. Re-running the job
    must then land on the key prepare computed (same string on both sides)."""
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))
    book = _book(db, chapters=1, per_chapter=1)
    book.genre = "Mystery"
    db.commit()
    segment = _segments(db, book)[0]
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    run_tts_job(db, settings, row)
    assert row.status == "ready"

    save_voice_instructions(db, {"ashley-en": "Warm, expressive"})
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert (window[0][1].status, window[0][1].cache_key) == ("queued", None)

    claimed = claim_next_tts(db)
    assert claimed is not None
    run_tts_job(db, settings, claimed)
    assert claimed.status == "ready"
    key = cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        normalize_speech_text(segment.text),
        "Warm, expressive. You're narrating a Mystery novel.",
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    assert claimed.cache_key == key
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "ready"  # prepare and run_tts_job agree on the key


def test_run_tts_job_synthesizes_with_the_voice_narration_prompt(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[str | None] = []
    book = _book(db, chapters=1, per_chapter=1)
    book.genre = "Mystery"
    db.commit()
    segment = _segments(db, book)[0]
    save_voice_instructions(db, {"ashley-en": "Warm, expressive"})
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    monkeypatch.setattr(
        queue_module, "TtsClient", lambda _s: _FakeClient(_s, synth=_Synth(captured))
    )

    run_tts_job(db, settings, row)

    assert row.status == "ready"
    assert captured == ["Warm, expressive. You're narrating a Mystery novel."]


def test_tts_instructions_off_sends_no_prompt_and_keys_without_it(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """VoxCPM2 drops the reference transcript whenever a style prompt is sent and
    clones far less consistently, so the prompt must be switchable per engine."""
    settings = settings.model_copy(update={"tts_instructions": False})
    captured: list[str | None] = []
    book = _book(db, chapters=1, per_chapter=1)
    book.genre = "Mystery"
    db.commit()
    segment = _segments(db, book)[0]
    save_voice_instructions(db, {"ashley-en": "Warm, expressive"})
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    monkeypatch.setattr(
        queue_module, "TtsClient", lambda _s: _FakeClient(_s, synth=_Synth(captured))
    )

    run_tts_job(db, settings, row)

    assert row.status == "ready"
    assert len(captured) == 1 and not captured[0]  # the HTTP client omits an empty prompt
    assert row.cache_key == cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        normalize_speech_text(segment.text),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "ready"  # prepare keys it the same way


def test_concurrent_prepares_of_the_same_segment_never_collide(
    db: Session, settings: Settings
) -> None:
    """The player's prepare, the HLS playlist and its timeline all queue the same
    segment at once: the loser of the insert race used to 500 the playlist."""
    import threading
    import time

    book = _book(db, chapters=1, per_chapter=1)
    book_id, segment_id = book.id, _segments(db, book)[0].id
    other = SessionLocal()
    result: dict[str, Any] = {}

    def racing_prepare() -> None:
        session = SessionLocal()
        try:
            racing_book = session.get(Book, book_id)
            assert racing_book is not None
            result["window"] = prepare(session, settings, racing_book, segment_id, 0, "ashley-en")
        except Exception as exc:  # noqa: BLE001 - surfaced by the assert below
            result["error"] = exc
        finally:
            session.close()

    try:
        # Another request has inserted the row but not committed yet.
        other.add(SegmentAudio(segment_id=segment_id, voice="ashley-en", priority=100))
        other.flush()
        thread = threading.Thread(target=racing_prepare)
        thread.start()
        time.sleep(0.5)  # the racing insert is now waiting on the uncommitted row
        other.commit()
        thread.join(10)
    finally:
        other.close()

    assert "error" not in result, result.get("error")
    rows = db.scalars(select(SegmentAudio).where(SegmentAudio.segment_id == segment_id)).all()
    assert len(rows) == 1
    assert rows[0].priority == 10  # the racing prepare still raised it to needed-now


def test_a_split_segment_is_found_in_the_cache_by_the_next_prepare(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """prepare and the worker must agree on the key of a segment synthesized
    as several requests, or every play would re-synthesize it."""
    settings = settings.model_copy(update={"tts_request_chars": 400})  # one sentence each
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    segment.text = " ".join(
        f"Sentence {n} walks slowly along the harbour wall in the evening fog." for n in range(10)
    )
    db.commit()
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    synth = _Synth()
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s, synth=synth))
    run_tts_job(db, settings, row)
    assert row.status == "ready"
    assert len(synth.captured) > 1  # split into several requests

    db.delete(row)  # a fresh prepare must find the clip, not queue a new synthesis
    db.commit()
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "ready"


def test_prepare_keeps_a_ready_clip_made_before_requests_were_split(
    db: Session, settings: Settings
) -> None:
    """A segment synthesized as one request (before TTS_REQUEST_CHARS) stays
    ready on its clip. Flipping it back to queued re-keyed every cached segment
    on deploy: an iOS HLS stream that had listed it then shrank (Safari stalled
    on "Preparing audio") and swapped clips under the timeline (read-along
    drifted)."""
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    segment.text = " ".join(
        f"Sentence {n} walks slowly along the harbour wall in the evening fog." for n in range(10)
    )
    db.commit()
    legacy = _seed_audio(db, settings, segment.text)  # the single-request key (no |req=N)
    db.add(
        SegmentAudio(
            segment_id=segment.id,
            voice="ashley-en",
            status="ready",
            cache_key=legacy.cache_key,
            priority=10,
        )
    )
    db.commit()

    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")

    row = window[0][1]
    assert (row.status, row.cache_key) == ("ready", legacy.cache_key)


def test_prepare_requeues_a_ready_row_whose_clip_file_is_gone(
    db: Session, settings: Settings
) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    segment = _segments(db, book)[0]
    legacy = _seed_audio(db, settings, segment.text)
    Path(legacy.path).unlink()
    db.add(
        SegmentAudio(
            segment_id=segment.id, voice="ashley-en", status="ready", cache_key=legacy.cache_key
        )
    )
    db.commit()
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "queued"  # evicted: synthesize again


def _ready_on(db: Session, segment: Segment, audio: Audio) -> None:
    db.add(
        SegmentAudio(
            segment_id=segment.id, voice="ashley-en", status="ready", cache_key=audio.cache_key
        )
    )
    db.commit()


def _long_segment(db: Session, book: Book) -> Segment:
    segment = _segments(db, book)[0]
    segment.text = " ".join(
        f"Sentence {n} walks slowly along the harbour wall in the evening fog." for n in range(10)
    )
    db.commit()
    return segment


def test_prepare_keeps_a_ready_clip_from_the_300_character_split(
    db: Session, settings: Settings
) -> None:
    """v0.1.14/v0.1.15 split segments into ~300-character requests. Those clips
    stay ready: changing how requests are split must never re-queue a ready
    segment (an iOS stream that listed it would stall)."""
    book = _book(db, chapters=1, per_chapter=1)
    segment = _long_segment(db, book)
    old = _seed_audio(db, settings, segment.text)
    old_key = cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        normalize_speech_text(segment.text),
        narration_prompt(db, "ashley-en", None),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
        split="300",
    )
    old.cache_key = old_key  # filed under the v0.1.14 key
    db.commit()
    _ready_on(db, segment, old)
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert (window[0][1].status, window[0][1].cache_key) == ("ready", old_key)


def test_prepare_keeps_a_ready_clip_of_the_same_text_whatever_its_split(
    db: Session, settings: Settings
) -> None:
    book = _book(db, chapters=1, per_chapter=1)
    segment = _long_segment(db, book)
    clip = _seed_audio(db, settings, segment.text)
    clip.text_key, clip.cache_key = clip.cache_key, "f" * 64  # any future split scheme
    db.commit()
    _ready_on(db, segment, clip)
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert (window[0][1].status, window[0][1].cache_key) == ("ready", "f" * 64)


def test_run_tts_job_announces_sentence_progress(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = settings.model_copy(update={"tts_request_chars": 400})  # one sentence each
    book = _book(db, chapters=1, per_chapter=1)
    segment = _long_segment(db, book)
    prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    monkeypatch.setattr(queue_module, "TtsClient", lambda _s: _FakeClient(_s))
    frames: list[dict[str, Any]] = []
    monkeypatch.setattr(queue_module, "notify", lambda _db, payload: frames.append(payload))

    run_tts_job(db, settings, row)

    progress = [f for f in frames if "done" in f]
    assert progress[0] == {
        "event": "audio",
        "book_id": str(book.id),
        "segment_id": str(segment.id),
        "status": "generating",
        "done": 0,
        "total": 10,
    }
    assert [f["done"] for f in progress] == list(range(11))
    assert frames[-1]["status"] == "ready" and "done" not in frames[-1]
