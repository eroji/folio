"""Cover API: upload a cover, set one from a URL, serve it with hash caching."""

import mimetypes
from collections.abc import Iterator
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.covers import (
    DOWNLOAD_TIMEOUT_S,
    MAX_COVER_BYTES,
    MAX_REDIRECTS,
    cover_path,
    download_cover,
    store_cover,
)
from folio.db import get_session
from folio.deps import can_edit_book, get_current_user
from folio.errors import ApiError
from folio.models import Book, User
from folio.security import require_csrf

router = APIRouter(prefix="/api/v1/books", tags=["covers"])

_MB = MAX_COVER_BYTES // (1024 * 1024)
_SIZE_WIDTH: dict[str, Literal[200, 600] | None] = {"200": 200, "600": 600, "original": None}


def get_http_client() -> Iterator[httpx.Client]:
    """Sync client for cover downloads; tests override with ``httpx.MockTransport``."""
    with httpx.Client(
        timeout=DOWNLOAD_TIMEOUT_S, follow_redirects=True, max_redirects=MAX_REDIRECTS
    ) as client:
        yield client


class CoverUrlBody(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


def _get_book(db: DbSession, book_id: UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


def _require_edit(user: User, book: Book) -> None:
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only edit books you uploaded.", 403)


def _stored(book: Book) -> dict[str, Any]:
    assert book.cover_key is not None  # set by the caller right before this
    return {
        "cover_url": f"/api/v1/books/{book.id}/cover?v={book.cover_key[:8]}",
        "cover_key": book.cover_key,
    }


@router.post("/{book_id}/cover")
async def upload_cover(
    request: Request,
    book_id: UUID,
    file: UploadFile,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    _require_edit(user, book)
    # Read one byte past the cap so an oversize upload never lands in memory.
    data = await file.read(MAX_COVER_BYTES + 1)
    if len(data) > MAX_COVER_BYTES:
        raise ApiError("cover_too_large", f"Cover image exceeds the {_MB} MB limit.", 413)
    book.cover_key = store_cover(get_settings(), book.id, data)
    db.commit()
    return _stored(book)


@router.put("/{book_id}/cover-url")
def set_cover_url(
    request: Request,
    book_id: UUID,
    body: CoverUrlBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    http_client: Annotated[httpx.Client, Depends(get_http_client)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    _require_edit(user, book)
    # A failed download/store raises before cover_key changes: the old cover stays.
    book.cover_key = store_cover(get_settings(), book.id, download_cover(body.url, http_client))
    db.commit()
    return _stored(book)


@router.get("/{book_id}/cover")
def get_cover(
    request: Request,
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    size: Literal["200", "600", "original"] = "600",
) -> Response:
    book = _get_book(db, book_id)
    path = cover_path(get_settings(), book.id, _SIZE_WIDTH[size]) if book.cover_key else None
    if path is None:
        raise ApiError("not_found", "Cover not found.", 404)
    etag = f'"{book.cover_key}-{size}"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=31536000, immutable"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return Response(content=path.read_bytes(), media_type=media_type, headers=headers)
