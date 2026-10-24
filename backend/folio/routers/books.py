"""Book API: upload, catalog list/search, detail, cover, delete, reprocess, segments."""

import hashlib
import mimetypes
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import can_edit_book, get_current_user
from folio.errors import ApiError
from folio.ingest import DRM_MESSAGE
from folio.ingest.detect import Format, detect_format, epub_is_drm_protected
from folio.jobs import enqueue, notify
from folio.models import Book, BookFile, Chapter, Segment, User
from folio.models.book import BOOK_SEARCH_EXPR
from folio.security import require_csrf
from folio.storage import book_dir, cover_dir, ensure_dirs, original_path

router = APIRouter(prefix="/api/v1/books", tags=["books"])

PAGE_SIZE = 24
CHUNK_SIZE = 1024 * 1024
_EXT_RE = re.compile(r"[a-z0-9]{1,8}")
_FORMAT_EXT = {Format.EPUB: "epub", Format.PDF: "pdf", Format.KINDLE: "mobi"}


class BookPublic(BaseModel):
    """Book payload without uploaded_by/locked_fields (not exposed, see DECISIONS)."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    subtitle: str | None
    authors: list[str]
    series: str | None
    series_index: float | None
    description: str | None
    publisher: str | None
    published_date: str | None
    language: str
    isbn10: str | None
    isbn13: str | None
    tags: list[str]
    narrator_voice: str | None
    cover_url: str | None = None
    status: str
    error: str | None
    total_chars: int
    est_duration_s: float
    created_at: datetime
    updated_at: datetime


class ChapterPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    idx: int
    title: str
    char_count: int


def _public(book: Book) -> BookPublic:
    public = BookPublic.model_validate(book)
    public.cover_url = (
        f"/api/v1/books/{book.id}/cover?v={book.cover_key[:8]}" if book.cover_key else None
    )
    return public


def _get_book(db: DbSession, book_id: UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


def _cover_file(settings: Settings, book_id: UUID) -> Path | None:
    files = sorted(cover_dir(settings, book_id).glob("original.*"))
    return files[0] if files else None


def _stream_to_temp(upload: UploadFile, settings: Settings) -> tuple[Path, str, int]:
    """Stream to ``data_dir/tmp`` while hashing; 413 as soon as the limit is passed."""
    limit = settings.max_upload_mb * 1024 * 1024
    tmp = ensure_dirs(settings.data_dir / "tmp") / f"{uuid.uuid4().hex}"
    hasher = hashlib.sha256()
    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := upload.file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > limit:
                    raise ApiError(
                        "upload_too_large",
                        f"File exceeds the maximum upload size of {settings.max_upload_mb} MB.",
                        413,
                    )
                hasher.update(chunk)
                out.write(chunk)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return tmp, hasher.hexdigest(), size


def _check_format(tmp: Path) -> Format:
    fmt = detect_format(tmp)
    if fmt is Format.KFX or (fmt is Format.EPUB and epub_is_drm_protected(tmp)):
        raise ApiError("unsupported_format", DRM_MESSAGE, 422)
    if fmt is Format.UNKNOWN:
        raise ApiError("unsupported_format", "Unsupported file type", 422)
    return fmt


@router.post("")
def upload_books(
    request: Request,
    files: list[UploadFile],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> list[dict[str, Any]]:
    require_csrf(request, request.state.session_row)
    settings = get_settings()
    results: list[dict[str, Any]] = []
    for upload in files:
        tmp: Path | None = None
        try:
            tmp, sha, size = _stream_to_temp(upload, settings)
            fmt = _check_format(tmp)
            existing = db.scalar(select(BookFile).where(BookFile.sha256 == sha))
            if existing is not None:  # dedupe by content hash, spec step 1
                results.append(
                    {
                        "book_id": str(existing.book_id),
                        "job_id": None,
                        "duplicate_of": str(existing.book_id),
                    }
                )
                continue
            filename = Path(upload.filename or "Untitled")
            suffix = filename.suffix.removeprefix(".").lower()
            ext = suffix if _EXT_RE.fullmatch(suffix) else _FORMAT_EXT[fmt]
            book = Book(
                title=filename.stem or "Untitled",
                status="uploading",
                uploaded_by=user.id,
                language="en",
            )
            db.add(book)
            db.flush()
            dest = original_path(settings, book.id, ext)
            ensure_dirs(dest.parent)
            os.replace(tmp, dest)
            tmp = None  # moved; do not unlink below
            db.add(
                BookFile(
                    book_id=book.id,
                    kind="original",
                    format=fmt.value,
                    path=str(dest),
                    size_bytes=size,
                    sha256=sha,
                )
            )
            job = enqueue(db, "ingest", book.id)
            db.commit()
            notify(db, {"event": "book", "book_id": str(book.id), "status": "uploading"})
            results.append({"book_id": str(book.id), "job_id": str(job.id), "duplicate_of": None})
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
    return results


@router.get("")
def list_books(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    q: str | None = None,
    sort: Literal["recent", "title", "author", "progress"] = "recent",
    status: str | None = None,
    page: int = Query(1, ge=1),
) -> dict[str, Any]:
    stmt = select(Book)
    if q:
        # websearch_to_tsquery treats any input as words/operators, never errors;
        # the expression matches the GIN index (ix_books_search).
        stmt = stmt.where(
            text(f"{BOOK_SEARCH_EXPR} @@ websearch_to_tsquery('simple', :q)").bindparams(q=q)
        )
    if status:
        stmt = stmt.where(Book.status == status)
    count_stmt = select(func.count()).select_from(stmt.subquery())
    order = {
        "title": func.lower(Book.title),
        # First author; empty arrays sort last (Postgres ASC default).
        "author": Book.authors[1],
    }.get(sort, Book.created_at.desc())
    if sort == "progress":
        # TODO(M5): order by the caller's last progress update.
        order = Book.created_at.desc()
    books = db.scalars(
        stmt.order_by(order, Book.id).offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )
    return {
        "items": [_public(b) for b in books],
        "total": db.scalar(count_stmt) or 0,
        "page": page,
        "page_size": PAGE_SIZE,
    }


@router.get("/{book_id}")
def get_book(
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    book = _get_book(db, book_id)
    chapters = db.scalars(
        select(Chapter).where(Chapter.book_id == book.id).order_by(Chapter.idx)
    ).all()
    # Progress is M5; the shape is pinned by the spec so the UI can code against it.
    return {
        "book": _public(book),
        "chapters": [ChapterPublic.model_validate(c) for c in chapters],
        "progress": None,
    }


@router.get("/{book_id}/cover")
def get_cover(
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    size: int = Query(600),
) -> Response:
    if size not in (200, 600):  # Literal[int] rejects the coerced query string in pydantic v2
        raise ApiError("validation_failed", "Invalid request", 422)
    # ponytail: size is accepted but ignored; real resizing is M3.
    book = _get_book(db, book_id)
    path = _cover_file(get_settings(), book.id) if book.cover_key else None
    if path is None:
        raise ApiError("not_found", "Cover not found.", 404)
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return Response(
        content=path.read_bytes(),
        media_type=media_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{book.cover_key}"',
        },
    )


@router.delete("/{book_id}", status_code=204)
def delete_book(
    request: Request,
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> None:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only delete books you uploaded.", 403)
    settings = get_settings()
    db.delete(book)  # files, chapters, segments and jobs cascade
    db.commit()
    shutil.rmtree(book_dir(settings, book_id), ignore_errors=True)
    shutil.rmtree(cover_dir(settings, book_id), ignore_errors=True)


@router.post("/{book_id}/reprocess")
def reprocess_book(
    request: Request,
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only reprocess books you uploaded.", 403)
    db.execute(delete(Chapter).where(Chapter.book_id == book.id))
    book.status = "uploading"
    book.error = None
    job = enqueue(db, "ingest", book.id)
    db.commit()
    notify(db, {"event": "book", "book_id": str(book.id), "status": "uploading"})
    return {"job_id": str(job.id)}


@router.get("/{book_id}/chapters/{chapter_id}/segments")
def chapter_segments(
    book_id: UUID,
    chapter_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    chapter = db.get(Chapter, chapter_id)
    if chapter is None or chapter.book_id != book_id:
        raise ApiError("not_found", "Chapter not found.", 404)
    segments = db.scalars(
        select(Segment).where(Segment.chapter_id == chapter.id).order_by(Segment.idx)
    ).all()
    return {
        "items": [
            {
                "id": str(s.id),
                "idx": s.idx,
                "text": s.text,
                "char_start": s.char_start,
                "char_end": s.char_end,
            }
            for s in segments
        ]
    }
