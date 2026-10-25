"""Audio API: lookahead prepare, retry, and Range streaming of cached clips."""

import re
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError
from folio.models import Audio, Book, Chapter, Segment, User
from folio.security import require_csrf
from folio.tts.queue import prepare, retry

router = APIRouter(tags=["audio"])

_MEDIA_TYPE = {"opus": "audio/ogg", "mp3": "audio/mpeg"}
_HEX64_RE = re.compile(r"[0-9a-f]{64}")
# last_played_at drives LRU eviction; a per-minute touch per key is plenty.
TOUCH_INTERVAL_S = 60.0
_last_touch: dict[str, float] = {}


class PrepareBody(BaseModel):
    segment_id: UUID
    count: int | None = Field(default=None, ge=0, le=100)
    voice: str | None = Field(default=None, min_length=1, max_length=64)


class RetryBody(BaseModel):
    segment_id: UUID
    voice: str | None = Field(default=None, min_length=1, max_length=64)


def _get_book(db: DbSession, book_id: UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


@router.post("/api/v1/books/{book_id}/audio/prepare")
def prepare_audio(
    request: Request,
    book_id: UUID,
    body: PrepareBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Queue the current segment plus ``count`` lookahead ones; any listener may call it."""
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    rows = prepare(db, settings, book, body.segment_id, body.count, body.voice)
    items = []
    for segment, row in rows:
        audio = db.get(Audio, row.cache_key) if row.cache_key else None
        items.append(
            {
                "segment_id": str(segment.id),
                "status": row.status,
                "cache_key": row.cache_key,
                "url": f"/api/v1/audio/{row.cache_key}" if audio else None,
                "duration_s": audio.duration_s if audio else None,
            }
        )
    return {"items": items, "language": book.language, "voice": rows[0][1].voice}


@router.post("/api/v1/books/{book_id}/audio/retry", status_code=202)
def retry_audio(
    request: Request,
    book_id: UUID,
    body: RetryBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    _get_book(db, book_id)
    segment = db.get(Segment, body.segment_id)
    chapter = db.get(Chapter, segment.chapter_id) if segment else None
    if chapter is None or chapter.book_id != book_id:
        raise ApiError("not_found", "Segment not found.", 404)
    row = retry(db, settings, body.segment_id, body.voice)
    return {"status": row.status}


@router.get("/api/v1/audio/{cache_key}")
def stream_audio(
    cache_key: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> FileResponse:
    """Stream one cached clip with HTTP Range (FileResponse does 206/416 natively)."""
    if not _HEX64_RE.fullmatch(cache_key):
        raise ApiError("not_found", "Audio not found.", 404)
    row = db.get(Audio, cache_key)
    if row is None:
        raise ApiError("not_found", "Audio not found.", 404)
    path = Path(row.path)
    if not path.is_file():
        raise ApiError("not_found", "Audio not found.", 404)
    now = monotonic()
    if now - _last_touch.get(cache_key, 0.0) >= TOUCH_INTERVAL_S:
        _last_touch[cache_key] = now
        row.last_played_at = datetime.now(UTC)
        db.commit()
    return FileResponse(
        path,
        media_type=_MEDIA_TYPE.get(row.format, "application/octet-stream"),
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
