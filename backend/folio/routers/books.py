"""Book API: upload, catalog list/search, detail, cover, delete, reprocess, segments."""

import hashlib
import math
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal, NoReturn
from uuid import UUID

import bleach  # type: ignore[import-untyped]
from fastapi import APIRouter, Depends, Query, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import can_edit_book, get_current_user
from folio.errors import ApiError
from folio.ingest import DRM_MESSAGE
from folio.ingest.detect import Format, detect_format, epub_is_drm_protected
from folio.jobs import enqueue, notify
from folio.models import Book, BookFile, Chapter, Progress, Segment, User
from folio.models.book import BOOK_SEARCH_EXPR
from folio.routers.progress import progress_dict
from folio.security import require_csrf
from folio.storage import book_dir, cover_dir, ensure_dirs, original_path

router = APIRouter(prefix="/api/v1/books", tags=["books"])

PAGE_SIZE = 24
GROUP_BOOKS = 12  # books returned per group when listing with group=
CHUNK_SIZE = 1024 * 1024
_EXT_RE = re.compile(r"[a-z0-9]{1,8}")
_LANG_RE = re.compile(r"[a-z]{2,3}(-[A-Za-z0-9]{2,8})*")  # BCP-47-ish
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
    genre: str | None = None
    narrator_voice: str | None
    cover_url: str | None = None
    cover_rgb: str | None = None
    status: str
    error: str | None
    total_chars: int
    est_duration_s: float
    created_at: datetime
    updated_at: datetime
    can_edit: bool = False  # computed per caller in _public; uploaded_by stays hidden


class ChapterPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    idx: int
    title: str
    char_count: int
    excluded: bool


def _public(book: Book, user: User) -> BookPublic:
    public = BookPublic.model_validate(book)
    public.can_edit = can_edit_book(user, book)
    public.cover_url = (
        f"/api/v1/books/{book.id}/cover?v={book.cover_key[:8]}" if book.cover_key else None
    )
    return public


class BookPatch(BaseModel):
    """PATCH /books/{id} body: every field optional. ``model_fields_set``
    distinguishes "not provided" from an explicit null (null clears optional
    fields; title/language/authors/tags map to NOT NULL columns and reject null)."""

    title: str | None = Field(default=None, max_length=512)
    subtitle: str | None = Field(default=None, max_length=512)
    authors: list[str] | None = None
    series: str | None = Field(default=None, max_length=255)
    series_index: float | None = None
    description: str | None = None  # Text column: no length cap
    publisher: str | None = Field(default=None, max_length=255)
    published_date: str | None = Field(default=None, max_length=32)
    language: str | None = Field(default=None, max_length=16)
    isbn10: str | None = Field(default=None, max_length=17)
    isbn13: str | None = Field(default=None, max_length=13)
    tags: list[str] | None = None
    genre: str | None = Field(default=None, max_length=80)
    narrator_voice: str | None = Field(default=None, max_length=64)


class ChapterPatch(BaseModel):
    """PATCH /books/{id}/chapters/{cid} body: the exclusion toggle."""

    excluded: bool


def _fail() -> NoReturn:
    raise ApiError("validation_failed", "Invalid request", 422)


def _clean_str(value: str | None) -> str | None:
    """Strip whitespace; an empty optional string reads as "clear"."""
    if value is None:
        return None
    return value.strip() or None


def _clean_list(values: list[str] | None) -> list[str]:
    """Trim, reject empty items, dedupe preserving order."""
    if values is None:
        _fail()
    items = [v.strip() for v in values]
    if not all(items):
        _fail()
    return list(dict.fromkeys(items))


def _clean_isbn(value: str | None, digits: int) -> str | None:
    """Strip separators, validate the checksum, store normalized digits."""
    if not value:
        return None
    norm = value.replace("-", "").replace(" ", "").upper()
    pattern = r"\d{9}[\dX]" if digits == 10 else r"\d{13}"
    if not re.fullmatch(pattern, norm):
        _fail()
    if digits == 10:
        total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(norm))
        valid = total % 11 == 0
    else:
        total = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(norm))
        valid = total % 10 == 0
    if not valid:
        _fail()
    return norm


def _patch_values(patch: BookPatch) -> dict[str, object | None]:
    """Validate the provided fields only; map field name -> value to write."""
    provided = patch.model_fields_set
    values: dict[str, object | None] = {}
    if "title" in provided:
        title = (patch.title or "").strip()
        if not title:
            _fail()
        values["title"] = title
    for name in ("subtitle", "series", "publisher", "published_date", "narrator_voice"):
        if name in provided:
            values[name] = _clean_str(getattr(patch, name))
    if "genre" in provided:
        values["genre"] = _clean_str(patch.genre)
    if "description" in provided:
        # Plain text for M3 (see DECISIONS): all markup stripped, never rendered raw.
        raw = patch.description
        values["description"] = (
            bleach.clean(raw, tags=[], strip=True).strip() or None if raw else None
        )
    for name in ("authors", "tags"):
        if name in provided:
            values[name] = _clean_list(getattr(patch, name))
    if "language" in provided:
        if patch.language is None or not _LANG_RE.fullmatch(patch.language):
            _fail()
        values["language"] = patch.language
    if "series_index" in provided:
        index = patch.series_index
        if index is not None and (not math.isfinite(index) or index < 0):
            _fail()
        values["series_index"] = index
    if "isbn10" in provided:
        values["isbn10"] = _clean_isbn(patch.isbn10, 10)
    if "isbn13" in provided:
        values["isbn13"] = _clean_isbn(patch.isbn13, 13)
    return values


def _get_book(db: DbSession, book_id: UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


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
                # Cap to the column width: client filenames are arbitrary length.
                title=(filename.stem or "Untitled")[:512],
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
            job = enqueue(db, "ingest", book.id, user_id=user.id)
            db.commit()
            notify(db, {"event": "book", "book_id": str(book.id), "status": "uploading"})
            results.append({"book_id": str(book.id), "job_id": str(job.id), "duplicate_of": None})
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
    return results


def _group_key(book: Book, group: str) -> tuple[str | None, str]:
    """(key, label) for one book under a group-by mode."""
    if group == "genre":
        return book.genre, book.genre or "No genre yet"
    if group == "author":
        author = book.authors[0] if book.authors else None
        return author, author or "Unknown author"
    if group == "language":
        return book.language, book.language
    return book.status, book.status


def _grouped(books: list[Book], group: str, user: User) -> list[dict[str, Any]]:
    """Bucket books by group, largest-first for genre ("No genre yet" last),
    by label otherwise (unknown last); each group carries its first GROUP_BOOKS."""
    buckets: dict[str | None, list[Book]] = {}
    for book in books:
        buckets.setdefault(_group_key(book, group)[0], []).append(book)

    def sort_key(item: tuple[str | None, list[Book]]) -> tuple[bool, object]:
        key, book_list = item
        label = _group_key(book_list[0], group)[1]
        if group == "genre":
            return (key is None, (-len(book_list), label))
        return (key is None, label.lower())

    return [
        {
            "key": key,
            "label": _group_key(book_list[0], group)[1],
            "count": len(book_list),
            "books": [_public(b, user) for b in book_list[:GROUP_BOOKS]],
        }
        for key, book_list in sorted(buckets.items(), key=sort_key)
    ]


@router.get("")
def list_books(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    q: str | None = None,
    sort: Literal["recent", "title", "author", "progress"] = "recent",
    status: str | None = None,
    genre: str | None = None,
    group: Literal["genre", "author", "language", "status", "none"] | None = None,
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
    if genre:
        stmt = stmt.where(Book.genre.is_(None) if genre == "none" else Book.genre == genre)
    if sort == "progress":
        # One progress row per (user, book), so the outer join cannot duplicate
        # rows; books this user never opened sort last.
        stmt = stmt.outerjoin(
            Progress, (Progress.book_id == Book.id) & (Progress.user_id == user.id)
        )
    order = {
        "title": func.lower(Book.title),
        # First author; empty arrays sort last (Postgres ASC default).
        "author": Book.authors[1],
        "progress": Progress.updated_at.desc().nulls_last(),
    }.get(sort, Book.created_at.desc())
    if group is not None and group != "none":
        # Grouped listing ignores paging: shelves show the first GROUP_BOOKS
        # per group and "See all" falls back to the flat, paged list.
        all_books = list(db.scalars(stmt.order_by(order, Book.id)))
        return {"groups": _grouped(all_books, group, user)}
    count_stmt = select(func.count()).select_from(stmt.subquery())
    books = db.scalars(
        stmt.order_by(order, Book.id).offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    )
    return {
        "items": [_public(b, user) for b in books],
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
    # All chapters, excluded ones included with their flag: the UI lists them
    # under an "Excluded chapters" disclosure so the owner can re-enable them.
    chapters = db.scalars(
        select(Chapter).where(Chapter.book_id == book.id).order_by(Chapter.idx)
    ).all()
    row = db.get(Progress, (user.id, book.id))
    return {
        "book": _public(book, user),
        "chapters": [ChapterPublic.model_validate(c) for c in chapters],
        "progress": progress_dict(row) if row else None,
    }


@router.patch("/{book_id}")
def patch_book(
    request: Request,
    book_id: UUID,
    patch: BookPatch,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """Edit metadata; every provided field is appended to locked_fields so
    no later automatic fetch overwrites it (spec: Metadata → Editing)."""
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only edit books you uploaded.", 403)
    values = _patch_values(patch)
    for name, value in values.items():
        setattr(book, name, value)
    book.locked_fields = list(dict.fromkeys([*book.locked_fields, *patch.model_fields_set]))
    db.commit()
    return {"book": _public(book, user)}


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
    job = enqueue(db, "ingest", book.id, user_id=user.id)
    db.commit()
    notify(db, {"event": "book", "book_id": str(book.id), "status": "uploading"})
    return {"job_id": str(job.id)}


@router.patch("/{book_id}/chapters/{chapter_id}")
def patch_chapter(
    request: Request,
    book_id: UUID,
    chapter_id: UUID,
    body: ChapterPatch,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """Exclude or re-include one chapter; totals and every saved progress
    percentage follow suit so completion is measured only against what plays."""
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only edit books you uploaded.", 403)
    chapter = db.get(Chapter, chapter_id)
    if chapter is None or chapter.book_id != book.id:
        raise ApiError("not_found", "Chapter not found.", 404)
    chapter.excluded = body.excluded
    included = db.scalars(
        select(Chapter)
        .where(Chapter.book_id == book.id, Chapter.excluded.is_(False))
        .order_by(Chapter.idx)
    ).all()
    total = sum(other.char_count for other in included)
    book.total_chars = total
    book.est_duration_s = total / get_settings().tts_chars_per_second

    # Stored percentages were measured against the old total. Recompute them
    # now, otherwise excluding front matter silently lowers completion.
    for saved in db.scalars(select(Progress).where(Progress.book_id == book.id)).all():
        saved_chapter = db.get(Chapter, saved.chapter_id)
        if saved_chapter is None:
            continue
        chars = sum(other.char_count for other in included if other.idx < saved_chapter.idx)
        if not saved_chapter.excluded:
            segment = db.get(Segment, saved.segment_id)
            chars += segment.char_start if segment else 0
        saved.percent = min(100.0, max(0.0, chars / total * 100)) if total else 0.0
    db.commit()
    return {"chapter": ChapterPublic.model_validate(chapter).model_dump(mode="json")}


@router.get("/{book_id}/chapters/{chapter_id}/segments")
def chapter_segments(
    book_id: UUID,
    chapter_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    chapter = db.get(Chapter, chapter_id)
    if chapter is None or chapter.book_id != book_id or chapter.excluded:
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
