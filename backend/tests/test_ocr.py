"""Scanned PDFs are read by the language model when OCR is on (else needs_ocr,
as before); pages read are cached so a failed import resumes."""

from __future__ import annotations

import itertools
import re
import uuid
from pathlib import Path

import pytest
from mock_llm import completion, has_image, serve
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_pipeline import _chapters, _reload, _seed_book

from folio.config import Settings
from folio.ingest.pipeline import process_book
from folio.integrations import Integrations, LanguageModel, save_integrations
from folio.llm import LlmError
from folio.models import Job, Segment

PAGE = "The lighthouse keeper climbed the stairs again. " * 6  # > 200 chars a page
_pages = itertools.count(1)


def page_text() -> str:
    # Distinct per page: lines repeated on most pages are dropped as running headers.
    n = next(_pages)
    return f"Night {n}. " + PAGE.replace("again", f"again, time {n}")


def _ocr_on(db: Session, url: str, **extra: object) -> None:
    model = LanguageModel(base_url=url, model="chat", ocr_model="vision", ocr=True, **extra)  # type: ignore[arg-type]
    save_integrations(db, Integrations(language_model=model))
    db.commit()


def _numbered(body: dict) -> tuple[int, dict]:
    return completion(page_text())


def test_ocr_reads_a_scanned_pdf_into_a_playable_book(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    with serve(_numbered) as (url, requests):
        _ocr_on(db, url)
        book = _seed_book(db, settings, fixture_books["scanned_pdf"])
        process_book(db, settings, book.id)
    book = _reload(db, book.id)
    assert book.status == "ready", book.error
    assert len(requests) == 8  # every page of the 8-page scan, once
    assert all(r["model"] == "vision" and has_image(r) for r in requests)
    chapters = _chapters(db, book)
    assert len(chapters) == 1  # no outline: one 20-page chunk
    text = "".join(db.scalars(select(Segment.text).where(Segment.chapter_id == chapters[0].id)))
    assert "lighthouse keeper" in text
    assert book.total_chars > 8 * 200


def test_a_failed_page_fails_the_book_and_a_retry_reads_only_the_rest(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    failing = {"on": True}

    def flaky(body: dict) -> tuple[int, dict]:
        # Page 6 (index 5) fails while `failing` is on; the page is identified by
        # the request order the first time, so fail by count instead.
        if failing["on"] and flaky.calls >= 5:  # type: ignore[attr-defined]
            return 500, {"error": {"message": "GPU fell over"}}
        flaky.calls += 1  # type: ignore[attr-defined]
        return completion(page_text())

    flaky.calls = 0  # type: ignore[attr-defined]
    with serve(flaky) as (url, requests):
        _ocr_on(db, url)
        book = _seed_book(db, settings, fixture_books["scanned_pdf"])
        with pytest.raises(LlmError):
            process_book(db, settings, book.id)
        book = _reload(db, book.id)
        assert book.status == "failed"
        assert re.match(
            r"Reading page \d+ failed: The language model returned HTTP 500", book.error or ""
        )
        read_before = flaky.calls  # type: ignore[attr-defined]
        failing["on"] = False
        before = len(requests)
        process_book(db, settings, book.id)
        book = _reload(db, book.id)
        assert book.status == "ready", book.error
        # Only the pages not read the first time are asked for again.
        assert len(requests) - before == 8 - read_before


def test_without_ocr_a_scanned_pdf_still_needs_ocr(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    save_integrations(
        db, Integrations(language_model=LanguageModel(base_url="http://x/v1", model="m"))
    )
    db.commit()
    book = _seed_book(db, settings, fixture_books["scanned_pdf"])
    process_book(db, settings, book.id)
    assert _reload(db, book.id).status == "needs_ocr"


def test_suggestions_are_queued_after_import_only_when_switched_on(
    db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    def jobs(book_id: uuid.UUID) -> list[str]:
        return list(db.scalars(select(Job.type).where(Job.book_id == book_id)))

    book = _seed_book(db, settings, fixture_books["epub3"])
    process_book(db, settings, book.id)
    assert jobs(book.id) == []
    save_integrations(
        db,
        Integrations(language_model=LanguageModel(base_url="http://x/v1", model="m", suggest=True)),
    )
    db.commit()
    process_book(db, settings, book.id)
    assert jobs(book.id) == ["suggest"]
