"""Front and back matter is turned off on import (the owner can turn any of
it back on under Manage): marked by the OPF guide, by epub:type, or simply
titled like it. Dedications, epigraphs and prologues stay on: audiobooks
read them."""

from __future__ import annotations

from pathlib import Path

from ebooklib import epub
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.ingest import ExtractedChapter
from folio.ingest.epub import extract_epub
from folio.ingest.pipeline import _persist_chapters
from folio.models import Book, Chapter

_TEXT = "<p>" + "Words to narrate here. " * 4 + "</p>"


def _page(name: str, body: str, toc_title: str | None = None) -> tuple[epub.EpubHtml, str | None]:
    item = epub.EpubHtml(file_name=name, title=toc_title or "")
    item.content = f"<html><head></head><body>{body}</body></html>"
    return item, toc_title


def _build(tmp_path: Path) -> Path:
    book = epub.EpubBook()
    book.set_identifier("matter-test")
    book.set_title("Matter")
    book.set_language("en")
    pages = [
        _page(
            "also.xhtml", "<h2>Also by Liz Moore</h2><p>Long Bright River. The Unseen World.</p>"
        ),
        _page("copyright.xhtml", f'<section epub:type="copyright-page">{_TEXT}</section>'),
        _page(
            "dedication.xhtml", '<section epub:type="dedication"><p>For my sister.</p></section>'
        ),
        _page("contents.xhtml", f"<h2>Contents</h2>{_TEXT}"),
        _page(
            "epigraph.xhtml", "<blockquote><p>Many a pedestrian is incredulous.</p></blockquote>"
        ),
        _page("louise.xhtml", f"<h2>Louise</h2><h2>August 1975</h2>{_TEXT}"),
        _page("ack.xhtml", f"<h2>Acknowledgments</h2>{_TEXT}", toc_title="Acknowledgments"),
        _page("about.xhtml", f"<h2>About the Author</h2>{_TEXT}"),
        _page("next.xhtml", f"<h2>What’s next on your reading list?</h2>{_TEXT}"),
    ]
    for item, _ in pages:
        book.add_item(item)
    book.toc = [epub.Link(item.file_name, title, item.file_name) for item, title in pages if title]
    book.spine = [item for item, _ in pages]
    book.guide = [{"type": "toc", "href": "contents.xhtml", "title": "Table of Contents"}]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    path = tmp_path / "matter.epub"
    epub.write_epub(str(path), book)
    return path


def test_front_and_back_matter_is_off_and_the_story_is_on(tmp_path: Path) -> None:
    chapters = extract_epub(_build(tmp_path)).chapters
    assert [(c.text.split()[0], c.excluded) for c in chapters] == [
        ("Also", True),  # titled "Also by …"
        ("Words", True),  # epub:type="copyright-page"
        ("For", False),  # dedication: read aloud
        ("Contents", True),  # OPF guide type="toc"
        ("Many", False),  # epigraph: read aloud
        ("Louise", False),  # the story
        ("Acknowledgments", True),
        ("About", True),
        ("What’s", True),  # the publisher's reading-list ad
    ]


def test_excluded_chapters_are_stored_off_and_left_out_of_the_length(
    db: Session, settings: Settings
) -> None:
    book = Book(title="Lengths", language="en", status="processing")
    db.add(book)
    db.flush()
    _persist_chapters(
        db,
        settings,
        book,
        [
            ExtractedChapter(title="Copyright", text="All rights reserved.", excluded=True),
            ExtractedChapter(title="Louise", text="The bed is empty."),
        ],
    )
    db.commit()
    stored = db.query(Chapter).filter(Chapter.book_id == book.id).order_by(Chapter.idx).all()
    assert [c.excluded for c in stored] == [True, False]
    assert book.total_chars == len("The bed is empty.")
