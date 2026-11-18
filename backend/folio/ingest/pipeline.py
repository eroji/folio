"""The ``ingest`` job handler: extract → clean → segment → metadata → ready.

Status flow (spec, Book ingestion): ``uploading`` (set at upload) →
``processing`` → ``ready`` | ``needs_ocr`` | ``failed``. The handler is
idempotent: chapters/segments are deleted before being rebuilt, so a
reprocess or a retry never duplicates rows.
"""

import logging
from pathlib import Path
from uuid import UUID

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.covers import store_cover
from folio.errors import ApiError
from folio.ingest import (
    EmbeddedMetadata,
    ExtractedBook,
    ExtractedChapter,
    ScannedPDF,
    UnsupportedFormat,
)
from folio.ingest.clean import clean_chapters
from folio.ingest.detect import Format, detect_format
from folio.ingest.epub import extract_epub
from folio.ingest.kindle import extract_kindle
from folio.ingest.pdf import extract_pdf
from folio.ingest.segment import segment_chapter
from folio.metadata.service import auto_fetch, genre_from_subjects
from folio.models import Book, BookFile, Chapter, Job, Segment
from folio.storage import book_dir
from folio.text import description_text

logger = logging.getLogger(__name__)


def process_book(session: Session, settings: Settings, target: UUID | Job) -> None:
    """Run the ingest pipeline for one book.

    Takes a ``Job`` (the worker's ``Handler`` signature) or a bare book UUID
    (tests, direct calls); both spellings are pinned by the plan.
    """
    book_id = target.book_id if isinstance(target, Job) else target
    if book_id is None:
        raise ValueError("ingest job has no book")
    book = session.get(Book, book_id)
    if book is None:  # deleted while the job was queued
        return
    book.status = "processing"
    book.error = None
    session.commit()
    try:
        _ingest(session, settings, book)
    except Exception as exc:
        session.rollback()
        book = session.get(Book, book_id)
        if book is not None:
            book.status = "failed"
            book.error = _readable_error(exc)
            session.commit()
        raise


def _readable_error(exc: Exception) -> str:
    # UnsupportedFormat already carries the spec's DRM message; everything
    # else shows the exception text (never a traceback).
    return str(exc) or type(exc).__name__


def _ingest(session: Session, settings: Settings, book: Book) -> None:
    original = session.scalar(
        select(BookFile).where(BookFile.book_id == book.id, BookFile.kind == "original")
    )
    if original is None or not Path(original.path).is_file():
        raise FileNotFoundError("The stored original file is missing.")
    path = Path(original.path)
    scanned = False
    try:
        extracted = _extract(settings, book, path)
    except ScannedPDF as exc:  # spec step 5: still add metadata/cover, not playable
        scanned = True
        extracted = ExtractedBook(
            chapters=[], metadata=exc.metadata or EmbeddedMetadata(), cover=exc.cover
        )
    _apply_metadata(book, extracted.metadata)
    _store_cover(settings, book, extracted.cover)
    _persist_chapters(session, settings, book, extracted.chapters)
    book.status = "needs_ocr" if scanned else "ready"
    session.commit()
    if settings.metadata_online:
        _online_metadata(session, settings, book)


def _online_metadata(session: Session, settings: Settings, book: Book) -> None:
    """Best-effort online metadata; a provider failure logs and never fails ingest."""
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            auto_fetch(session, settings, book, client)
    except Exception:
        session.rollback()
        logger.warning("online metadata skipped for book %s", book.id, exc_info=True)


def _extract(settings: Settings, book: Book, path: Path) -> ExtractedBook:
    fmt = detect_format(path)  # magic bytes, never the extension
    if fmt is Format.EPUB:
        return extract_epub(path)
    if fmt is Format.PDF:
        return extract_pdf(path)
    if fmt is Format.KINDLE:
        return extract_kindle(path, workdir=book_dir(settings, book.id))
    raise UnsupportedFormat("kfx" if fmt is Format.KFX else "unknown")


def _apply_metadata(book: Book, meta: EmbeddedMetadata) -> None:
    """File metadata wins; locked_fields (set by M3 edits) is never overwritten."""
    description = description_text(meta.description) or None if meta.description else None
    fields: dict[str, object | None] = {
        "title": meta.title or book.title,  # book.title is the filename stem from upload
        "authors": meta.authors or None,
        "series": meta.series,
        "series_index": meta.series_index,
        "description": description,
        "publisher": meta.publisher,
        "published_date": meta.published_date,
        "isbn10": meta.isbn10,
        "isbn13": meta.isbn13,
        "tags": meta.tags or None,
        "language": meta.language or "en",
    }
    for name, value in fields.items():
        if value is not None and name not in book.locked_fields:
            setattr(book, name, value)
    # The file's own subjects are the only genre hint on an offline import;
    # a manual genre (locked) always wins and is never overwritten here.
    if book.genre is None and "genre" not in book.locked_fields:
        derived = genre_from_subjects(meta.tags)
        if derived:
            book.genre = derived


def _store_cover(settings: Settings, book: Book, cover: bytes | None) -> None:
    if not cover:
        return
    try:
        book.cover_key, book.cover_rgb = store_cover(settings, book.id, cover)
    except ApiError:
        pass  # an unsupported embedded cover leaves the book cover-less, never fails ingest


def _persist_chapters(
    session: Session, settings: Settings, book: Book, chapters: list[ExtractedChapter]
) -> None:
    # Idempotent reprocess: segments cascade-delete with their chapters.
    session.execute(delete(Chapter).where(Chapter.book_id == book.id))
    language = book.language
    total = 0
    for idx, chapter in enumerate(clean_chapters(chapters, language)):
        segmented = segment_chapter(chapter, language, max_chars=settings.tts_max_chars)
        row = Chapter(
            book_id=book.id,
            idx=idx,
            # No made-up title: folio.chapters numbers untitled chapters among
            # the ones set to narrate when they are shown.
            title=chapter.title.strip(),
            char_count=len(chapter.text),
            excluded=chapter.excluded,
        )
        session.add(row)
        session.flush()
        for seg_idx, seg in enumerate(segmented.segments):
            session.add(
                Segment(
                    chapter_id=row.id,
                    idx=seg_idx,
                    text=seg.text,
                    char_start=seg.char_start,
                    char_end=seg.char_end,
                )
            )
        if not chapter.excluded:  # the book's length is what will be narrated
            total += len(chapter.text)
    book.total_chars = total
    book.est_duration_s = total / settings.tts_chars_per_second
