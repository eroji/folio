"""Listening progress: GET/PUT/DELETE /books/{id}/progress and the finished toggle.

The book row is the resume point (the last place listened); every save also
updates that chapter's own row, so each chapter keeps its place and a
listened flag (``chapter_progress``)."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError
from folio.models import Book, Chapter, ChapterProgress, Progress, Segment, User
from folio.security import require_csrf

router = APIRouter(prefix="/api/v1/books", tags=["progress"])

# A stored position from another device further ahead than this prompts the
# player instead of a silent overwrite (spec: Progress model -> Conflicts).
AHEAD_THRESHOLD_S = 60.0


class ProgressPut(BaseModel):
    chapter_id: uuid.UUID
    segment_id: uuid.UUID
    offset_s: float = Field(ge=0)
    device_label: str = Field(max_length=64)
    # The chapter was played to its end: it counts as listened and its next
    # visit starts from the top.
    chapter_finished: bool = False


class FinishedPut(BaseModel):
    finished: bool


def progress_dict(row: Progress) -> dict[str, Any]:
    """Wire shape shared by /books/{id}, /books/{id}/progress and /me/continue."""
    return {
        "chapter_id": row.chapter_id,
        "segment_id": row.segment_id,
        "offset_s": row.offset_s,
        "percent": row.percent,
        "device_label": row.device_label,
        "updated_at": row.updated_at,
        "finished_at": row.finished_at,
    }


def chapter_progress_dict(
    row: ChapterProgress, segment: Segment | None, chapter: Chapter
) -> dict[str, Any]:
    """Wire shape of ``chapters[].progress`` in GET /books/{id}."""
    if segment is None:
        percent = 100.0 if row.finished_at else 0.0
    else:
        percent = (
            min(100.0, segment.char_start / chapter.char_count * 100) if chapter.char_count else 0.0
        )
    return {
        "segment_id": row.segment_id,
        "offset_s": row.offset_s,
        "percent": percent,
        "finished": row.finished_at is not None,
    }


def _save_chapter_position(
    db: DbSession, user: User, chapter: Chapter, segment: Segment, body: ProgressPut
) -> None:
    row = db.get(ChapterProgress, (user.id, chapter.id))
    if row is None:
        row = ChapterProgress(user_id=user.id, chapter_id=chapter.id, book_id=chapter.book_id)
        db.add(row)
    now = datetime.now(UTC)
    if body.chapter_finished:
        row.finished_at = now
        row.segment_id = None
        row.offset_s = 0.0
    else:
        row.segment_id = segment.id
        row.offset_s = body.offset_s
    row.updated_at = now


def _get_book(db: DbSession, book_id: uuid.UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


def _chars_before(db: DbSession, chapter: Chapter) -> int:
    """Book-global character offset where this chapter starts (excluded
    chapters count as nothing, matching the recomputed ``total_chars``)."""
    return (
        db.scalar(
            select(func.coalesce(func.sum(Chapter.char_count), 0)).where(
                Chapter.book_id == chapter.book_id,
                Chapter.idx < chapter.idx,
                Chapter.excluded.is_(False),
            )
        )
        or 0
    )


def _ahead_of_other_device(
    db: DbSession, previous: Progress | None, chapter: Chapter, segment: Segment, label: str
) -> bool:
    """True when the stored row came from another device and was >60 s ahead."""
    if previous is None or previous.device_label == label:
        return False
    prev_chapter = db.get(Chapter, previous.chapter_id)
    prev_segment = db.get(Segment, previous.segment_id)
    if prev_chapter is None or prev_segment is None:  # cascade keeps this impossible
        return False
    cps = get_settings().tts_chars_per_second
    ahead_s = (_chars_before(db, prev_chapter) + prev_segment.char_start) / cps
    incoming_s = (_chars_before(db, chapter) + segment.char_start) / cps
    return ahead_s - incoming_s > AHEAD_THRESHOLD_S


def _finish_all_chapters(
    db: DbSession, user: User, book_id: uuid.UUID, at: datetime | None
) -> None:
    """Marking a book finished marks every narrated chapter listened."""
    existing = {
        row.chapter_id: row
        for row in db.scalars(
            select(ChapterProgress).where(
                ChapterProgress.user_id == user.id, ChapterProgress.book_id == book_id
            )
        )
    }
    chapters = db.scalars(
        select(Chapter).where(Chapter.book_id == book_id, Chapter.excluded.is_(False))
    )
    for chapter in chapters:
        row = existing.get(chapter.id)
        if row is None:
            row = ChapterProgress(user_id=user.id, chapter_id=chapter.id, book_id=book_id)
            db.add(row)
        if row.finished_at is None:
            row.finished_at = at
            row.segment_id = None
            row.offset_s = 0.0
            row.updated_at = at or datetime.now(UTC)


@router.get("/{book_id}/progress")
def get_progress(
    book_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    _get_book(db, book_id)
    row = db.get(Progress, (user.id, book_id))
    return {"progress": progress_dict(row) if row else None}


@router.put("/{book_id}/progress")
def put_progress(
    request: Request,
    book_id: uuid.UUID,
    body: ProgressPut,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    chapter = db.get(Chapter, body.chapter_id)
    if chapter is None or chapter.book_id != book.id:
        raise ApiError("not_found", "Chapter not found.", 404)
    segment = db.get(Segment, body.segment_id)
    if segment is None or segment.chapter_id != chapter.id:
        raise ApiError("not_found", "Segment not found.", 404)

    previous = db.get(Progress, (user.id, book.id))
    ahead = _ahead_of_other_device(db, previous, chapter, segment, body.device_label)
    chars_before = _chars_before(db, chapter)
    percent = 0.0
    if book.total_chars:
        percent = min(100.0, max(0.0, (chars_before + segment.char_start) / book.total_chars * 100))

    row = previous
    if row is None:
        row = Progress(user_id=user.id, book_id=book.id)
        db.add(row)
    row.chapter_id = chapter.id
    row.segment_id = segment.id
    row.offset_s = body.offset_s
    row.percent = percent
    row.device_label = body.device_label
    row.updated_at = datetime.now(UTC)  # last write wins by updated_at
    _save_chapter_position(db, user, chapter, segment, body)
    db.commit()
    return {"progress": progress_dict(row), "ahead_of_other_device": ahead}


@router.delete("/{book_id}/progress", status_code=204)
def delete_progress(
    request: Request,
    book_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> None:
    require_csrf(request, request.state.session_row)
    row = db.get(Progress, (user.id, book_id))
    if row is not None:
        db.delete(row)
    db.execute(
        delete(ChapterProgress).where(
            ChapterProgress.user_id == user.id, ChapterProgress.book_id == book_id
        )
    )
    db.commit()


@router.put("/{book_id}/progress/finished")
def put_finished(
    request: Request,
    book_id: uuid.UUID,
    body: FinishedPut,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    row = db.get(Progress, (user.id, book_id))
    if row is None:
        raise ApiError("not_found", "Progress not found.", 404)
    row.finished_at = datetime.now(UTC) if body.finished else None
    if body.finished:
        _finish_all_chapters(db, user, book_id, row.finished_at)
    db.commit()
    return {"progress": progress_dict(row)}
