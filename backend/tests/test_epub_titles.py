"""EPUB chapter titles: table of contents, then the chapter's own heading.

Modelled on a real book (The God of the Woods): its TOC lists only front
matter and part titles, no file has a <title>, and every story chapter names
itself in an <h2> ("Louise", subtitle "August 1975"). Folio used to call those
"Chapter 7", "Chapter 8"... (numbered by position, front matter included).
"""

from __future__ import annotations

from folio.ingest.epub import _chapter_content


class _Item:
    def __init__(self, name: str, body: str, title: str = "") -> None:
        self._name = name
        head = f"<title>{title}</title>" if title else ""
        self._html = f"<html><head>{head}</head><body>{body}</body></html>"

    def get_name(self) -> str:
        return self._name

    def get_content(self) -> bytes:
        return self._html.encode()


LOUISE = (
    '<div><h2 class="x03-Chapter-Title"><span epub:type="pagebreak" title="9"/>Louise</h2>'
    '<h2 class="x03-Chapter-Subtitle">August 1975</h2>'
    '<p class="x03-CO-Body-Text">The bed is empty.</p></div>'
)
VICTOR = (
    '<div><h2 class="x03-Chapter-Title">Victor</h2>'
    '<p class="x14-Date-Line">1950s | 1961 | Winter 1973</p>'
    "<p>Together, they lifted the canoe.</p></div>"
)


def test_the_table_of_contents_wins() -> None:
    title, _ = _chapter_content(
        _Item("009_I_Barbara.xhtml", "<h2>I</h2><p>Barbara</p>"),
        {"009_I_Barbara.xhtml": "I. Barbara"},
    )
    assert title == "I. Barbara"


def test_a_chapter_missing_from_the_toc_takes_its_heading_and_subtitle() -> None:
    title, text = _chapter_content(_Item("010_Louise.xhtml", LOUISE), {})
    assert title == "Louise · August 1975"
    assert text.startswith("Louise")  # the heading is still narrated


def test_a_heading_without_a_subtitle_heading_stands_alone() -> None:
    title, _ = _chapter_content(_Item("101_Victor.xhtml", VICTOR), {})
    assert title == "Victor"


def test_a_meaningful_html_title_is_used_when_there_is_no_heading() -> None:
    title, _ = _chapter_content(_Item("a.xhtml", "<p>Text.</p>", title="Prologue"), {})
    assert title == "Prologue"


def test_generic_numbering_in_the_html_title_is_ignored() -> None:
    for generic in ("Chapter 7", "7", "Section 12", "chapter_0007", "part0005.xhtml"):
        title, _ = _chapter_content(_Item("a.xhtml", "<p>Text.</p>", title=generic), {})
        assert title == "", generic  # untitled: numbered among the narrated chapters
