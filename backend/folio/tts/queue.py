"""``segment_audio`` as the TTS generation queue (plan Wave 1, Task B).

Playback tops the queue up with ``prepare`` (current segment + lookahead);
the worker claims rows ``FOR UPDATE SKIP LOCKED`` and runs ``run_tts_job``.
No separate jobs plumbing: the rows double as queue and state.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from folio.config import Settings
from folio.errors import ApiError
from folio.jobs import notify
from folio.models import (
    Audio,
    Book,
    Chapter,
    PronunciationRule,
    Segment,
    SegmentAudio,
)
from folio.tts import (
    TtsClient,
    TtsError,
    discover_voices,
    get_or_synthesize,
    normalize_speech_text,
    select_voice,
)
from folio.tts.cache import single_request_key, speech_cache_key, v014_split_key
from folio.tts.narration import engine_instructions
from folio.tts.pronunciation import apply_rules
from folio.voice_catalog import effective_defaults

logger = logging.getLogger(__name__)

# Segments needed now go first; lookahead is lower priority, nearest first (spec: Priority).
PRIORITY_NOW = 10
PRIORITY_LOOKAHEAD = 100


def _resolve_voice(
    session: Session,
    settings: Settings,
    book: Book,
    user_settings: dict[str, Any] | None = None,
    requested: str | None = None,
) -> str:
    """Run the selection order against the engine's current voice list and
    the admin-set per-language defaults.

    ``requested`` is the voice the player asked for. It is honoured only while
    the engine still lists it: an id left over from a previous TTS server (or a
    stale pin) would otherwise be synthesized by whatever that engine substitutes
    for an unknown voice, and cached under the wrong id. An unreachable engine
    (no voice list) still trusts the request.
    """
    with TtsClient(settings) as client:
        voices = discover_voices(settings, client)
    known = {v.id for v in voices}
    if requested is not None:
        if not known or requested in known:
            return requested
        logger.warning("voice %r is not offered by the TTS engine; falling back", requested)
    return select_voice(
        book, user_settings or {}, settings, voices, effective_defaults(session, voices)
    )


def _ordered_segments(session: Session, book: Book) -> list[Segment]:
    return list(
        session.scalars(
            select(Segment)
            .join(Chapter, Segment.chapter_id == Chapter.id)
            .where(Chapter.book_id == book.id, Chapter.excluded.is_(False))
            .order_by(Chapter.idx, Segment.idx)
        )
    )


def _segment_row(
    session: Session, segment_id: UUID, voice: str, priority: int
) -> tuple[SegmentAudio, bool]:
    """The (segment, voice) row, inserted when missing; ``(row, created)``.

    The player's prepare, the HLS playlist and its timeline queue the same
    segment at the same moment. ON CONFLICT DO NOTHING waits for a concurrent
    insert to commit and then skips, so the loser re-reads the winner's row
    instead of failing on the unique index.
    """
    inserted = session.execute(
        pg_insert(SegmentAudio)
        .values(id=uuid4(), segment_id=segment_id, voice=voice, status="queued", priority=priority)
        .on_conflict_do_nothing(index_elements=["segment_id", "voice"])
        .returning(SegmentAudio.id)
    ).scalar_one_or_none()
    row = session.scalar(
        select(SegmentAudio)
        .where(SegmentAudio.segment_id == segment_id, SegmentAudio.voice == voice)
        .execution_options(populate_existing=True)
    )
    assert row is not None  # inserted above, or by the concurrent winner
    return row, inserted is not None


def _rules(session: Session, book_id: UUID) -> list[PronunciationRule]:
    """The book's accepted pronunciation rules in creation order (apply_rules
    order); suggestions change nothing until accepted."""
    return list(
        session.scalars(
            select(PronunciationRule)
            .where(PronunciationRule.book_id == book_id, PronunciationRule.suggested.is_(False))
            .order_by(PronunciationRule.created_at, PronunciationRule.id)
        )
    )


def invalidate_book_audio(session: Session, book_id: UUID) -> None:
    """Drop a book's queue rows after a pronunciation-rule change.

    The next ``prepare`` re-queues every segment with the corrected text (new
    cache keys); the old ``audio`` rows and files stay for eviction.
    """
    segment_ids = (
        select(Segment.id)
        .join(Chapter, Segment.chapter_id == Chapter.id)
        .where(Chapter.book_id == book_id)
        .scalar_subquery()
    )
    session.execute(delete(SegmentAudio).where(SegmentAudio.segment_id.in_(segment_ids)))
    session.commit()
    notify(
        session,
        {"event": "audio", "book_id": str(book_id), "segment_id": None, "status": "invalidated"},
    )


def prepare(
    session: Session,
    settings: Settings,
    book: Book,
    segment_id: UUID,
    count: int | None = None,
    voice: str | None = None,
    user_settings: dict[str, Any] | None = None,
) -> list[tuple[Segment, SegmentAudio]]:
    """Queue ``count + 1`` segments from ``segment_id``; cache hits go straight to ready.

    ``count`` defaults to ``settings.tts_lookahead``. Idempotent: an existing
    ``generating`` row is preserved, a ``queued`` row only gains priority (a
    seek raises it), and ``failed`` waits for the retry button.
    """
    voice = _resolve_voice(session, settings, book, user_settings, requested=voice)
    if count is None:
        count = settings.tts_lookahead
    rules = _rules(session, book.id)
    instructions = engine_instructions(session, settings, voice, book.genre, book.delivery_note)
    segments = _ordered_segments(session, book)
    start = next((i for i, s in enumerate(segments) if s.id == segment_id), None)
    if start is None:
        raise ApiError("not_found", "Segment not found.", 404)

    window: list[tuple[Segment, SegmentAudio]] = []
    # Only a real status transition is worth an SSE frame. Preparing is polled
    # every second by every listener; notifying on idempotent calls makes the
    # player re-prepare on each frame and floods the browser.
    changed: list[tuple[Segment, SegmentAudio, bool]] = []
    for offset, segment in enumerate(segments[start : start + count + 1]):
        normalized = normalize_speech_text(apply_rules(segment.text, rules))
        key = speech_cache_key(settings, voice, normalized, instructions, book.language)
        audio = session.get(Audio, key)
        if audio is not None and not Path(audio.path).is_file():
            audio = None  # row survived an eviction that removed the file
        # Lookahead ranks by distance: every row of one prepare shares created_at
        # (Postgres now() is the transaction start), so a flat priority left the
        # order to the random UUID and a prefetched chapter was synthesized out
        # of order. A nearer request only ever raises a row (min below).
        priority = PRIORITY_NOW if offset == 0 else PRIORITY_LOOKAHEAD + offset
        row, created = _segment_row(session, segment.id, voice, priority)
        before = None if created else row.status
        if audio is None and row.status == "ready" and row.cache_key != key:
            # A ready clip of the same text stays, however its requests were
            # split: re-queueing a ready segment shrinks an iOS HLS stream that
            # already listed it (Safari stalls) and swaps clips under its
            # timeline (read-along drifts). Only new audio uses the new split.
            # Clips from before text_key are recognized by their known keys.
            kept = session.get(Audio, row.cache_key) if row.cache_key else None
            same = single_request_key(settings, voice, normalized, instructions)
            if (
                kept is not None
                and Path(kept.path).is_file()
                and (
                    kept.text_key == same
                    or kept.cache_key
                    in (same, v014_split_key(settings, voice, normalized, instructions))
                )
            ):
                audio = kept
        if audio is not None:
            row.cache_key, row.status, row.error = audio.cache_key, "ready", None
        elif row.status == "queued":
            row.priority = min(row.priority, priority)
        elif row.status == "ready":
            row.cache_key, row.status, row.error = None, "queued", None  # file was cleared
        # generating keeps its claim; failed waits for retry()
        window.append((segment, row))
        after = row.status if not created else "queued"
        changed.append((segment, row, created or after != before))

    session.commit()
    for segment, row, is_change in changed:
        if is_change:
            _notify(session, str(book.id), segment.id, row.status)
    return window


def _notify(session: Session, book_id: str | None, segment_id: UUID, status: str) -> None:
    notify(
        session,
        {"event": "audio", "book_id": book_id, "segment_id": str(segment_id), "status": status},
    )


def urgent_priority(settings: Settings) -> int:
    """The lowest-urgency priority someone is waiting on: the playing segment
    and its lookahead window. Rows past it are background prefetch (the rest of
    a chapter) and wait behind imports."""
    return PRIORITY_LOOKAHEAD + settings.tts_lookahead


def claim_next_tts(session: Session, max_priority: int | None = None) -> SegmentAudio | None:
    """Claim the most urgent queued row (at most ``max_priority`` when given), or
    None. SKIP LOCKED: workers never collide."""
    conditions = [SegmentAudio.status == "queued"]
    if max_priority is not None:
        conditions.append(SegmentAudio.priority <= max_priority)
    row = (
        session.execute(
            select(SegmentAudio)
            .where(*conditions)
            .order_by(SegmentAudio.priority, SegmentAudio.created_at, SegmentAudio.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .first()
    )
    if row is None:
        session.commit()  # end the read transaction so no locks linger
        return None
    row.status = "generating"
    session.commit()
    return row


def run_tts_job(session: Session, settings: Settings, row: SegmentAudio) -> None:
    """Synthesize one claimed row to ready, or fail it with a readable error.

    Always releases the row: after this returns it is never ``generating``.
    """
    row_id = row.id
    segment = session.get(Segment, row.segment_id)
    chapter = session.get(Chapter, segment.chapter_id) if segment else None
    book_id = str(chapter.book_id) if chapter else None
    try:
        if segment is None:
            raise TtsError("The segment no longer exists.", code="segment_gone")
        rules = _rules(session, chapter.book_id) if chapter else []
        book = session.get(Book, chapter.book_id) if chapter else None
        instructions = engine_instructions(
            session,
            settings,
            row.voice,
            book.genre if book else None,
            book.delivery_note if book else None,
        )

        def progress(done: int, total: int) -> None:
            # "4 of 11 sentences" for the player; no status change, so the
            # player only redraws (no re-prepare).
            notify(
                session,
                {
                    "event": "audio",
                    "book_id": book_id,
                    "segment_id": str(row.segment_id),
                    "status": "generating",
                    "done": done,
                    "total": total,
                },
            )

        with TtsClient(settings) as client:
            audio, _ = get_or_synthesize(
                session,
                settings,
                client,
                apply_rules(segment.text, rules),
                row.voice,
                instructions,
                language=book.language if book else "en",
                on_progress=progress,
            )
        row.cache_key, row.status, row.error = audio.cache_key, "ready", None
    except TtsError as exc:
        row.status, row.error = "failed", exc.message
    except Exception as exc:  # noqa: BLE001 - a stuck generating row is worse than a failure
        session.rollback()
        row.status, row.error = "failed", f"{type(exc).__name__}: {exc}"
    try:
        session.commit()
    except StaleDataError:
        # A chapter/pronunciation change deleted the row mid-synthesis. The
        # audio is cached; drop the orphaned status update and keep working.
        session.rollback()
        logger.info("segment_audio %s vanished during synthesis; result dropped", row_id)
        return
    _notify(session, book_id, row.segment_id, row.status)


def retry(
    session: Session, settings: Settings, segment_id: UUID, voice: str | None = None
) -> SegmentAudio:
    """Reset a failed segment for the player's retry button (failed → queued)."""
    del settings  # pinned signature; nothing here needs config
    stmt = select(SegmentAudio).where(SegmentAudio.segment_id == segment_id)
    if voice is not None:
        stmt = stmt.where(SegmentAudio.voice == voice)
    else:  # the retry button retries the segment's failed row, whatever voice it used
        stmt = stmt.where(SegmentAudio.status == "failed")
    row = session.scalar(stmt.order_by(SegmentAudio.created_at.desc()).limit(1))
    if row is None:
        raise ApiError("not_found", "No failed audio to retry for this segment.", 404)
    row.status, row.error, row.cache_key, row.priority = "queued", None, None, PRIORITY_NOW
    session.commit()
    segment = session.get(Segment, segment_id)
    chapter = session.get(Chapter, segment.chapter_id) if segment else None
    _notify(session, str(chapter.book_id) if chapter else None, segment_id, row.status)
    return row
