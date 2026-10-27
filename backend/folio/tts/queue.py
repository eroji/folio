"""``segment_audio`` as the TTS generation queue (plan Wave 1, Task B).

Playback tops the queue up with ``prepare`` (current segment + lookahead);
the worker claims rows ``FOR UPDATE SKIP LOCKED`` and runs ``run_tts_job``.
No separate jobs plumbing: the rows double as queue and state.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
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
    cache_key,
    discover_voices,
    get_or_synthesize,
    normalize_speech_text,
    select_voice,
)
from folio.tts.narration import narration_prompt
from folio.tts.pronunciation import apply_rules
from folio.voice_catalog import effective_defaults

logger = logging.getLogger(__name__)

# Segments needed now go first; lookahead is lower priority (spec: Priority).
PRIORITY_NOW = 10
PRIORITY_LOOKAHEAD = 100


def _resolve_voice(
    session: Session, settings: Settings, book: Book, user_settings: dict[str, Any] | None = None
) -> str:
    """Run the selection order against the engine's current voice list and
    the admin-set per-language defaults."""
    with TtsClient(settings) as client:
        voices = discover_voices(settings, client)
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


def _rules(session: Session, book_id: UUID) -> list[PronunciationRule]:
    """The book's pronunciation rules in creation order (apply_rules order)."""
    return list(
        session.scalars(
            select(PronunciationRule)
            .where(PronunciationRule.book_id == book_id)
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
    if voice is None:
        voice = _resolve_voice(session, settings, book, user_settings)
    if count is None:
        count = settings.tts_lookahead
    rules = _rules(session, book.id)
    instructions = narration_prompt(session, voice, book.genre)
    segments = _ordered_segments(session, book)
    start = next((i for i, s in enumerate(segments) if s.id == segment_id), None)
    if start is None:
        raise ApiError("not_found", "Segment not found.", 404)

    # ponytail: concurrent prepares of the same (segment, voice) can race the
    # unique index and surface a 500; re-select on IntegrityError if it bites.
    window: list[tuple[Segment, SegmentAudio]] = []
    # Only a real status transition is worth an SSE frame. Preparing is polled
    # every second by every listener; notifying on idempotent calls makes the
    # player re-prepare on each frame and floods the browser.
    changed: list[tuple[Segment, SegmentAudio, bool]] = []
    for offset, segment in enumerate(segments[start : start + count + 1]):
        key = cache_key(
            settings.tts_model,
            voice,
            settings.tts_format,
            normalize_speech_text(apply_rules(segment.text, rules)),
            instructions,
        )
        audio = session.get(Audio, key)
        if audio is not None and not Path(audio.path).is_file():
            audio = None  # row survived an eviction that removed the file
        row = session.scalar(
            select(SegmentAudio).where(
                SegmentAudio.segment_id == segment.id, SegmentAudio.voice == voice
            )
        )
        priority = PRIORITY_NOW if offset == 0 else PRIORITY_LOOKAHEAD
        created = row is None
        before = row.status if row is not None else None
        if row is None:
            row = SegmentAudio(segment_id=segment.id, voice=voice, priority=priority)
            session.add(row)
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


def claim_next_tts(session: Session) -> SegmentAudio | None:
    """Claim the most urgent queued row, or None. SKIP LOCKED: workers never collide."""
    row = (
        session.execute(
            select(SegmentAudio)
            .where(SegmentAudio.status == "queued")
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
        instructions = narration_prompt(session, row.voice, book.genre if book else None)
        with TtsClient(settings) as client:
            audio, _ = get_or_synthesize(
                session,
                settings,
                client,
                apply_rules(segment.text, rules),
                row.voice,
                instructions,
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
