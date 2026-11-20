"""EPUB chapter boundaries for a Calibre-converted book.

Modelled on a real upload (Verity): Calibre split two large chapter files into
``partNNNN_split_000.html`` / ``_split_001.html``. The table of contents points
only at ``_split_000``, so Folio used to turn each continuation into its own
chapter, titled after whatever heading it opened with (an epigraph, a scene
break), and to drop a ``_split_000`` whose only content was an image heading,
losing that chapter's TOC title. The book also has an untitled copyright
page, and after the acknowledgments a contact page, a "free sample" note and
an excerpt from another novel, all of which were set to narrate.
"""

from __future__ import annotations

from pathlib import Path

from ebooklib import epub

from folio.ingest.epub import extract_epub

_TEXT = "<p>" + "Words to narrate here. " * 40 + "</p>"
_LONG = _TEXT * 10


def _build(tmp_path: Path, pages: list[tuple[str, str, str | None]]) -> Path:
    book = epub.EpubBook()
    book.set_identifier("structure-test")
    book.set_title("Structure")
    book.set_language("en")
    items = []
    for name, body, _ in pages:
        item = epub.EpubHtml(
            uid=name.split(".")[0],
            file_name=f"text/{name}",
            title="",
            media_type="application/xhtml+xml",  # what Calibre declares for its .html
        )
        item.content = f"<html><head></head><body>{body}</body></html>"
        book.add_item(item)
        items.append(item)
    book.toc = [
        epub.Link(item.file_name, title, item.file_name)
        for item, (_, _, title) in zip(items, pages, strict=True)
        if title
    ]
    book.spine = items
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    path = tmp_path / "structure.epub"
    epub.write_epub(str(path), book)
    return path


def _first_word(text: str) -> str:
    return text.split()[0]


def test_calibre_split_files_rejoin_the_chapter_they_were_split_from(tmp_path: Path) -> None:
    path = _build(
        tmp_path,
        [
            ("part0004.html", f"<p>Opening</p>{_LONG}", "Chapter One"),
            ("part0008_split_000.html", f"<h1>Manuscript</h1><h1>by</h1>{_TEXT}", "Inset"),
            ("part0008_split_001.html", f"<h1>Epigraph line</h1>{_LONG}", None),
            ("part0009.html", f"<p>Middle</p>{_LONG}", "Chapter Two"),
            # an image-only chapter heading, then the chapter body Calibre split off
            ("part0037_split_000.html", '<p><img src="x.jpeg"/></p>', "Chapter Three"),
            ("part0037_split_001.html", f"<h1>Seven months later</h1>{_LONG}", None),
        ],
    )
    chapters = extract_epub(path).chapters
    assert [c.title for c in chapters] == ["Chapter One", "Inset", "Chapter Two", "Chapter Three"]
    inset = chapters[1].text
    assert inset.index("Manuscript") < inset.index("Epigraph line")  # one chapter, in order
    assert chapters[3].text.startswith("Seven months later")


def test_an_unlisted_file_that_is_not_a_split_stays_its_own_chapter(tmp_path: Path) -> None:
    path = _build(
        tmp_path,
        [
            ("part0001.html", f"<p>Opening</p>{_LONG}", "Part One"),
            ("part0002.html", f"<h2>Louise</h2>{_LONG}", None),
        ],
    )
    assert [c.title for c in extract_epub(path).chapters] == ["Part One", "Louise"]


def test_an_untitled_copyright_page_is_off(tmp_path: Path) -> None:
    path = _build(
        tmp_path,
        [
            (
                "part0001.html",
                (
                    "<p>Copyright 2018 by An Author</p><p>All rights reserved. No part of this"
                    " publication may be reproduced.</p>"
                ),
                None,
            ),
            ("part0003.html", "<p>This book is dedicated to my sister.</p>", None),
            ("part0004.html", f"<p>Opening</p>{_LONG}", "Chapter One"),
        ],
    )
    assert [(_first_word(c.text), c.excluded) for c in extract_epub(path).chapters] == [
        ("Copyright", True),
        ("This", False),  # dedication: read aloud
        ("Opening", False),
    ]


def test_everything_after_the_back_matter_is_off(tmp_path: Path) -> None:
    path = _build(
        tmp_path,
        [
            ("part0004.html", f"<p>Opening</p>{_LONG}", "Chapter One"),
            ("part0005.html", f"<p>Ending</p>{_LONG}", "Chapter Two"),
            ("part0040.html", f"<p>Thanks</p>{_TEXT}", "Acknowledgments"),
            ("part0041.html", f"<p>Follow</p>{_TEXT}", "Contact the Author"),
            ("part0042.html", "<p>Read on for a free sample of another novel.</p>", None),
            ("part0043_split_000.html", "<h1>Another Novel</h1>", "Another Novel"),
            ("part0043_split_001.html", f"<h1>Chapter One</h1>{_LONG}", None),
        ],
    )
    assert [(c.title, c.excluded) for c in extract_epub(path).chapters] == [
        ("Chapter One", False),
        ("Chapter Two", False),
        ("Acknowledgments", True),
        ("Contact the Author", True),
        ("", True),
        ("Another Novel", True),
    ]


def test_matter_early_in_the_book_does_not_switch_off_the_story(tmp_path: Path) -> None:
    # A teaser opens the book before the title and copyright pages.
    path = _build(
        tmp_path,
        [
            ("teaser.html", f"<p>Teaser</p>{_TEXT}", "Teaser"),
            ("title.html", "<p>The Book</p>", "Title Page"),
            ("part0004.html", f"<p>Opening</p>{_LONG}", "Chapter One"),
        ],
    )
    assert [(c.title, c.excluded) for c in extract_epub(path).chapters] == [
        ("Teaser", False),
        ("Title Page", True),
        ("Chapter One", False),
    ]
