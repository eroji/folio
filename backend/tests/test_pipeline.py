"""Task 8: the ingest job handler (pipeline.process_book)."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.ingest import DRM_MESSAGE, UnsupportedFormat
from folio.ingest.detect import detect_format
from folio.ingest.pipeline import process_book
from folio.jobs import enqueue
from folio.models import Book, BookFile, Chapter, Segment
from folio.storage import cover_dir, write_original

CALIBRE = shutil.which("ebook-convert") is not None


def _seed_book(db: Session, settings: Settings, path: Path, **fields: object) -> Book:
    """Create a book + stored original exactly like the upload endpoint does."""
    book = Book(status="uploading", language="en", **{"title": path.stem, **fields})
    db.add(book)
    db.flush()
    with path.open("rb") as fh:
        stored, sha, size = write_original(settings, book.id, path.suffix, fh)
    db.add(
        BookFile(
            book_id=book.id,
            kind="original",
            format=detect_format(stored).value,
            path=str(stored),
            size_bytes=size,
            sha256=sha,
        )
    )
    db.commit()
    return book


def _chapters(db: Session, book: Book) -> list[Chapter]:
    return list(db.scalars(select(Chapter).where(Chapter.book_id == book.id).order_by(Chapter.idx)))


def _reload(db: Session, book_id: uuid.UUID) -> Book:
    db.expire_all()
    book = db.get(Book, book_id)
    assert book is not None
    return book


def test_ingest_handler_is_registered() -> None:
    assert worker.HANDLERS["ingest"] is process_book


def test_epub3_reaches_ready_with_chapters_and_segments(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["epub3"])
    process_book(db, settings, book.id)
    book = _reload(db, book.id)
    assert book.status == "ready"
    assert book.error is None
    assert book.total_chars > 0
    assert book.est_duration_s == pytest.approx(book.total_chars / settings.tts_chars_per_second)
    assert book.title == "The Lighthouse at Low Tide"  # file metadata beats the stem
    assert book.authors == ["E. R. Tolliver"]
    assert book.language == "en"
    chapters = _chapters(db, book)
    assert len(chapters) >= 2
    assert [c.idx for c in chapters] == list(range(len(chapters)))
    assert all(c.char_count > 0 for c in chapters)
    first = chapters[0]
    segments = list(
        db.scalars(select(Segment).where(Segment.chapter_id == first.id).order_by(Segment.idx))
    )
    assert [s.idx for s in segments] == list(range(len(segments)))
    assert segments[0].char_start == 0
    assert all(s.text.strip() and s.char_end <= first.char_count for s in segments)
    assert sum(len(s.text) for s in segments) <= first.char_count


def test_pdf_outline_reaches_ready(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["pdf_outline"])
    process_book(db, settings, book.id)
    book = _reload(db, book.id)
    assert book.status == "ready"
    assert book.total_chars > 0
    assert len(_chapters(db, book)) >= 1


def test_scanned_pdf_needs_ocr_with_metadata_and_cover(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["scanned_pdf"])
    process_book(db, settings, book.id)
    book = _reload(db, book.id)
    assert book.status == "needs_ocr"
    assert book.total_chars == 0
    assert book.est_duration_s == 0.0
    assert _chapters(db, book) == []
    assert book.cover_key  # page 1 was rasterised into a cover
    assert list(cover_dir(settings, book.id).glob("original.*"))


def test_drm_epub_fails_with_the_spec_message(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["drm_epub"])
    with pytest.raises(UnsupportedFormat):
        process_book(db, settings, book.id)
    book = _reload(db, book.id)
    assert book.status == "failed"
    assert book.error == DRM_MESSAGE


def test_kfx_magic_fails_with_the_spec_message(
    db: Session, settings: Settings, tmp_path: Path
) -> None:
    kfx = tmp_path / "book.kfx"
    kfx.write_bytes(b"\x00" * 60 + b"\xeaDRMION\xee" + b"\x00" * 100)
    book = _seed_book(db, settings, kfx)
    with pytest.raises(UnsupportedFormat):
        process_book(db, settings, book.id)
    assert _reload(db, book.id).error == DRM_MESSAGE


def test_reader_exception_fails_book_and_job(
    db: Session,
    settings: Settings,
    fixture_books: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(_path: Path) -> object:
        raise RuntimeError("reader exploded")

    monkeypatch.setattr("folio.ingest.pipeline.extract_epub", boom)
    book = _seed_book(db, settings, fixture_books["epub3"])
    job = enqueue(db, "ingest", book.id)
    db.commit()
    with pytest.raises(RuntimeError, match="reader exploded"):
        process_book(db, settings, job)  # the worker's Job signature works too
    assert _reload(db, book.id).status == "failed"
    assert "reader exploded" in (_reload(db, book.id).error or "")


def test_worker_run_once_fails_job_on_reader_exception(
    db: Session,
    settings: Settings,
    fixture_books: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from folio.db import SessionLocal
    from folio.models import Job

    def boom(_path: Path) -> object:
        raise RuntimeError("reader exploded")

    monkeypatch.setattr("folio.ingest.pipeline.extract_epub", boom)
    book = _seed_book(db, settings, fixture_books["epub3"])
    job = enqueue(db, "ingest", book.id)
    db.commit()
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()
    db.expire_all()
    row = db.get(Job, job.id)
    assert row is not None and row.status == "failed"
    assert "reader exploded" in row.error


def test_reprocess_is_idempotent(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["epub3"])
    process_book(db, settings, book.id)
    counts = (len(_chapters(db, book)), db.scalar(select(func.count()).select_from(Segment)))
    process_book(db, settings, book.id)  # second run must not duplicate rows
    assert len(_chapters(db, book)) == counts[0]
    assert db.scalar(select(func.count()).select_from(Segment)) == counts[1]


def test_locked_fields_are_never_overwritten(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["epub3"], title="My Locked Title")
    book.locked_fields = ["title"]
    db.commit()
    process_book(db, settings, book.id)
    assert _reload(db, book.id).title == "My Locked Title"


def test_title_falls_back_to_the_filename_stem(
    db: Session, settings: Settings, tmp_path: Path
) -> None:
    # A PDF with no title metadata keeps the stem the upload endpoint stored.
    import pymupdf

    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "word " * 300)  # enough chars to not be "scanned"
    path = tmp_path / "Plain Filename.pdf"
    doc.save(path)
    book = _seed_book(db, settings, path)
    process_book(db, settings, book.id)
    assert _reload(db, book.id).title == "Plain Filename"


@pytest.mark.skipif(not CALIBRE, reason="Calibre ebook-convert is not installed")
def test_azw3_reaches_ready(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    book = _seed_book(db, settings, fixture_books["azw3"])
    process_book(db, settings, book.id)
    assert _reload(db, book.id).status == "ready"
