"""EPUB extraction: spine chapters with nav/NCX titles, OPF metadata, embedded cover."""

import re
import warnings
from pathlib import Path
from posixpath import basename
from typing import Any

import ebooklib  # type: ignore[import-untyped]
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from ebooklib import epub

from . import EmbeddedMetadata, ExtractedBook, ExtractedChapter, UnsupportedFormat
from .detect import epub_is_drm_protected

DROP_TAGS = ("script", "style", "img", "nav", "svg")
FOOTNOTE_LINK_TEXT = re.compile(r"^[0-9ivx]+$")


def extract_epub(path: Path) -> ExtractedBook:
    if epub_is_drm_protected(path):
        raise UnsupportedFormat("drm")
    book = epub.read_epub(str(path))
    titles = _toc_titles(book)
    guide = {
        basename(str(ref.get("href", "")).split("#")[0]): str(ref.get("type", "")).lower()
        for ref in getattr(book, "guide", None) or []
    }
    chapters: list[ExtractedChapter] = []
    for item_id, linear in book.spine:
        if linear == "no":
            continue
        item = book.get_item_with_id(item_id)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        soup = _parse(item)
        title, text = _title_and_text(item, soup, titles)
        if text.strip():  # nav pages and empty shells are not chapters
            excluded = _is_matter(title, soup, guide.get(basename(item.get_name()), ""))
            chapters.append(ExtractedChapter(title=title, text=text, excluded=excluded))
    return ExtractedBook(chapters=chapters, metadata=_metadata(book), cover=_cover(book))


def _toc_titles(book: epub.EpubBook) -> dict[str, str]:
    """Flatten the (possibly nested) nav/NCX TOC to file-name -> title."""
    titles: dict[str, str] = {}

    def walk(entry: Any) -> None:
        if isinstance(entry, epub.Link):
            titles.setdefault(basename(entry.href.split("#")[0]), entry.title.strip())
        elif isinstance(entry, epub.Section):
            for child in getattr(entry, "children", None) or []:
                walk(child)
        elif isinstance(entry, (tuple, list)):
            for child in entry:
                walk(child)

    for entry in book.toc:
        walk(entry)
    return titles


def _parse(item: Any) -> Any:
    # EPUB xhtml is XHTML; the lxml HTML parser is the right tool, so bs4's
    # "this looks like XML" warning is noise.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", XMLParsedAsHTMLWarning)
        return BeautifulSoup(item.get_content().decode("utf-8", "replace"), "lxml")


def _chapter_content(item: Any, titles: dict[str, str]) -> tuple[str, str]:
    return _title_and_text(item, _parse(item), titles)


# Front and back matter nobody wants narrated starts turned off (Manage turns
# it back on). Dedications, epigraphs, prefaces, prologues and author's notes
# stay on: audiobooks read them.
_MATTER_TYPES = frozenset(
    {
        "cover",
        "title-page",
        "titlepage",
        "halftitlepage",
        "toc",
        "copyright-page",
        "colophon",
        "acknowledgements",
        "acknowledgments",
        "index",
        "loi",
        "lot",
        "imprint",
        "other-credits",
    }
)
_MATTER_TITLE = re.compile(
    r"^(?:cover|title page|half[ -]title(?: page)?|copyright(?: page)?|(?:table of )?contents"
    r"|also by\b.*|other (?:books|titles) by\b.*|(?:more )?books by\b.*|by the same author\b.*"
    r"|praise for\b.*|acknowledge?ments?|about the authors?|about the publisher"
    r"|a note on the type|colophon|index|newsletter\b.*|sign up\b.*"
    r"|what[’']s next on your reading list\??|discover (?:more|your next)\b.*)$",
    re.IGNORECASE,
)


def _root_types(soup: Any) -> set[str]:
    """epub:type tokens on <body> and the sections directly inside it."""
    body = soup.body
    if body is None:
        return set()
    nodes = [body, *body.find_all(recursive=False)]
    nodes += [child for node in nodes[1:] for child in node.find_all(recursive=False)]
    return {token.lower() for node in nodes for token in str(node.get("epub:type") or "").split()}


def _is_matter(title: str, soup: Any, guide_type: str) -> bool:
    """Front/back matter: the OPF guide or epub:type says so, or it is titled like it."""
    if guide_type in _MATTER_TYPES or _root_types(soup) & _MATTER_TYPES:
        return True
    return bool(_MATTER_TITLE.match(" ".join(title.split()).rstrip(".")))


def _title_and_text(item: Any, soup: Any, titles: dict[str, str]) -> tuple[str, str]:
    for tag in soup.find_all(list(DROP_TAGS)):
        tag.decompose()
    for a in soup.find_all("a"):
        raw_href = a.get("href")
        href = raw_href if isinstance(raw_href, str) else ""
        if href.startswith("#") and (
            FOOTNOTE_LINK_TEXT.match(a.get_text(strip=True)) or a.get("role") == "doc-noteref"
        ):
            a.decompose()
    title = titles.get(basename(item.get_name())) or _heading_title(soup) or _html_title(soup)
    text = "\n".join(line for line in soup.get_text("\n").splitlines() if line.strip())
    return title, text


_HEADINGS = ["h1", "h2", "h3"]
_SUBHEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_MAX_TITLE = 120
# Conversion tools fill <title> with file numbering ("Chapter 7", "part0005"):
# meaningless once front matter is turned off, so such titles count as none.
_GENERIC_TITLE = re.compile(
    r"^(?:(?:chapter|chap|part|section|page|text)[\s_-]*)?[\divxlc]+(?:\.x?html?)?$", re.IGNORECASE
)


def _clean(text: str) -> str:
    return " ".join(text.split())


def _heading_title(soup: Any) -> str:
    """A chapter that is not in the table of contents names itself in its
    first heading; a heading right after it is its subtitle ("Louise ·
    August 1975")."""
    body = soup.body or soup
    heading = body.find(_HEADINGS)
    if heading is None:
        return ""
    title = _clean(heading.get_text(" "))
    following = heading.find_next_sibling()
    if title and following is not None and following.name in _SUBHEADINGS:
        subtitle = _clean(following.get_text(" "))
        if subtitle:
            title = f"{title} · {subtitle}"
    return title[:_MAX_TITLE]


def _html_title(soup: Any) -> str:
    title = _clean(soup.title.get_text(" ")) if soup.title else ""
    return "" if _GENERIC_TITLE.match(title) else title[:_MAX_TITLE]


def _first(book: epub.EpubBook, namespace: str, name: str) -> str | None:
    entries = book.get_metadata(namespace, name)
    return _text_of(entries[0][0]) if entries else None


def _text_of(value: Any) -> str | None:
    text = value.text if hasattr(value, "text") else str(value)
    return text.strip() if text and text.strip() else None


def _metadata(book: epub.EpubBook) -> EmbeddedMetadata:
    meta = EmbeddedMetadata(
        title=_first(book, "DC", "title"),
        authors=[t for t in (_text_of(v) for v in _all(book, "DC", "creator")) if t],
        language=_first(book, "DC", "language"),
        publisher=_first(book, "DC", "publisher"),
        published_date=_first(book, "DC", "date"),
        description=_first(book, "DC", "description"),
        tags=[t for t in (_text_of(v) for v in _all(book, "DC", "subject")) if t],
    )
    for value in _all(book, "DC", "identifier"):
        text = _text_of(value) or ""
        isbn = text.split("urn:isbn:", 1)[-1].replace("-", "").strip()
        if len(isbn) == 13:
            meta.isbn13 = isbn
        elif len(isbn) == 10:
            meta.isbn10 = isbn
    for element, _attrs in book.get_metadata("OPF", "meta"):
        name = element.get("name") if hasattr(element, "get") else None
        if name == "calibre:series" and meta.series is None:
            meta.series = element.get("content")
        elif name == "calibre:series_index" and meta.series_index is None:
            try:
                meta.series_index = float(element.get("content") or "")
            except ValueError:
                pass
    return meta


def _all(book: epub.EpubBook, namespace: str, name: str) -> list[Any]:
    return [entry[0] for entry in book.get_metadata(namespace, name)]


def _cover(book: epub.EpubBook) -> bytes | None:
    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        return item.get_content()
    for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        if "cover-image" in (getattr(item, "properties", None) or []):
            return item.get_content()
    # ponytail: EPUB2 guide-page covers (a cover *xhtml*, not image) not followed;
    # add a guide lookup here if real-world books need it.
    return None
