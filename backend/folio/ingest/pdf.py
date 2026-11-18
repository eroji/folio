"""PDF extraction via PyMuPDF (`import pymupdf` — never the old `fitz` name)."""

from collections import Counter
from io import BytesIO
from pathlib import Path

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

from . import EmbeddedMetadata, ExtractedBook, ExtractedChapter, ScannedPDF

CHUNK_PAGES = 20
SCANNED_MIN_CHARS_PER_PAGE = 200
MIN_PAGES_FOR_HEADER_FILTER = 5


def extract_pdf(path: Path) -> ExtractedBook:
    with pymupdf.open(path) as doc:
        if doc.page_count == 0:
            raise ScannedPDF("PDF has no pages")
        page_lines = [
            [line.strip() for line in page.get_text().splitlines() if line.strip()] for page in doc
        ]
        chars = sum(len(line) for lines in page_lines for line in lines)
        metadata = _metadata(doc)
        cover = _cover(doc)
        if chars / doc.page_count < SCANNED_MIN_CHARS_PER_PAGE:
            raise ScannedPDF(
                "PDF has under 200 extractable characters per page",
                metadata=metadata,
                cover=cover,
            )
        page_lines = _drop_repeated_lines(page_lines)
        return ExtractedBook(
            chapters=_chapters(doc, page_lines),
            metadata=metadata,
            cover=cover,
        )


def _drop_repeated_lines(page_lines: list[list[str]]) -> list[list[str]]:
    """Drop running headers/footers: lines that appear on more than 50% of pages."""
    if len(page_lines) < MIN_PAGES_FOR_HEADER_FILTER:
        return page_lines
    counts = Counter(line for lines in page_lines for line in set(lines))
    limit = len(page_lines) / 2
    return [[line for line in lines if counts[line] <= limit] for lines in page_lines]


def _chapters(doc: pymupdf.Document, page_lines: list[list[str]]) -> list[ExtractedChapter]:
    def text_of(start: int, end: int) -> str:
        return "\n\n".join("\n".join(page_lines[page]) for page in range(start, end))

    outline = [(title, page - 1) for _level, title, page in doc.get_toc() if page >= 1]
    if outline:
        # ponytail: front matter before the first outline entry is dropped;
        # prepend it to chapter 1 if real books need it.
        starts = [page for _title, page in outline] + [doc.page_count]
        return [
            ExtractedChapter(title=title.strip(), text=text_of(page, starts[index + 1]))
            for index, (title, page) in enumerate(outline)
        ]
    return [
        # Untitled: folio.chapters numbers them among the chapters set to narrate.
        ExtractedChapter(title="", text=text_of(start, min(start + CHUNK_PAGES, doc.page_count)))
        for start in range(0, doc.page_count, CHUNK_PAGES)
    ]


def _metadata(doc: pymupdf.Document) -> EmbeddedMetadata:
    raw = doc.metadata or {}

    def value(key: str) -> str | None:
        entry = (raw.get(key) or "").strip()
        return entry or None

    keywords = value("keywords")
    return EmbeddedMetadata(
        title=value("title"),
        authors=[author] if (author := value("author")) else [],
        language=(doc.language or "").strip() or None,
        description=value("subject"),
        published_date=value("creationDate"),
        tags=[tag.strip() for tag in keywords.split(",") if tag.strip()] if keywords else [],
    )


def _cover(doc: pymupdf.Document) -> bytes | None:
    # Only page 1: an image deeper in the book is a figure, not a cover.
    if doc.page_count == 0:
        return None
    for image in doc[0].get_images(full=True):
        try:
            return doc.extract_image(image[0])["image"]
        except (RuntimeError, KeyError):  # broken xref; fall back to a render
            break
    pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(2, 2))
    image = Image.frombytes("RGB" if pix.n == 3 else "RGBA", (pix.width, pix.height), pix.samples)
    return _crop_to_2_3(image.convert("RGB"))


def _crop_to_2_3(image: Image.Image) -> bytes:
    """Centre-crop a page render to the cover aspect ratio the spec pins (2:3)."""
    width, height = image.size
    if width * 3 > height * 2:  # too wide
        crop = height * 2 // 3
        image = image.crop(((width - crop) // 2, 0, (width - crop) // 2 + crop, height))
    elif width * 3 < height * 2:  # too tall
        crop = width * 3 // 2
        image = image.crop((0, (height - crop) // 2, width, (height - crop) // 2 + crop))
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()
