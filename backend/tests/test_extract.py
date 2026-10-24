"""EPUB/PDF/Kindle extraction. Self-contained: fixtures are built in tmp_path,
not from conftest's fixture_books (owned by another workstream)."""

import io
import shutil
import subprocess
import zipfile
from pathlib import Path

import pymupdf
import pytest
from ebooklib import epub
from PIL import Image

from folio.ingest import ExtractedBook, ScannedPDF, UnsupportedFormat
from folio.ingest.epub import extract_epub
from folio.ingest.kindle import extract_kindle
from folio.ingest.pdf import extract_pdf

DRM_MESSAGE = "This file is DRM-protected or in an unsupported Kindle format"
ENCRYPTION_XML = (
    '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>'
)


def build_epub(
    path: Path,
    chapters: list[tuple[str, str, str]],
    *,
    drm: bool = False,
    nested_toc: bool = False,
    cover: bytes | None = None,
) -> None:
    """chapters: (id, title, body-html)."""
    book = epub.EpubBook()
    book.set_identifier("uid-1")
    book.set_title("Test Title")
    book.set_language("en")
    book.add_author("Test Author")
    book.add_metadata("DC", "publisher", "Test Publisher", {})
    book.add_metadata("DC", "date", "2016-01-05", {})
    book.add_metadata("DC", "description", "A test book.", {})
    book.add_metadata("DC", "identifier", "urn:isbn:9781455540381", {})
    book.add_metadata("DC", "subject", "Testing", {})
    items = []
    for cid, title, body in chapters:
        item = epub.EpubHtml(title=title, file_name=f"{cid}.xhtml", lang="en")
        item.content = (
            f"<html><head><title>{title}</title></head><body>{body}</body></html>"
        ).encode()
        book.add_item(item)
        items.append(item)
    if cover is not None:
        image = epub.EpubCover(uid="cover-img", file_name="images/cover.jpg")
        image.content = cover
        book.add_item(image)
    if nested_toc:
        book.toc = [(epub.Section("Part One"), items)]
    else:
        book.toc = items
    book.add_item(epub.EpubNcx())
    book.spine = items
    epub.write_epub(path, book)
    if drm:
        with zipfile.ZipFile(path) as zf:
            entries = {i.filename: zf.read(i.filename) for i in zf.infolist()}
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, blob in entries.items():
                zf.writestr(name, blob)
            zf.writestr("META-INF/encryption.xml", ENCRYPTION_XML)


def make_text_pdf(
    path: Path,
    pages: int,
    footer: str | None = None,
    toc: list[list[object]] | None = None,
    metadata: dict[str, str] | None = None,
) -> None:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        for row in range(8):
            page.insert_text(
                (72, 100 + row * 20), f"Unique body text for page {i}, line {row}, of the book."
            )
        if footer:
            page.insert_text((72, 780), footer)
    if toc:
        doc.set_toc(toc)
    if metadata:
        doc.set_metadata(metadata)
    doc.save(path)
    doc.close()


def make_image_pdf(path: Path, pages: int) -> None:
    png = path.with_suffix(".seed.png")
    Image.new("RGB", (60, 80), (10, 20, 30)).save(png)
    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page()
        page.insert_image(page.rect, filename=str(png))
    doc.save(path)
    doc.close()
    png.unlink()


def all_text(book: ExtractedBook) -> str:
    return "\n".join(c.text for c in book.chapters)


class TestEpub:
    def test_chapters_from_spine_with_nested_toc_titles(self, tmp_path: Path) -> None:
        path = tmp_path / "book.epub"
        build_epub(
            path,
            [
                ("c1", "Chapter One", "<p>First prose paragraph.</p>"),
                ("c2", "Chapter Two", "<p>Second prose paragraph.</p>"),
                ("c3", "Chapter Three", "<p>Third prose paragraph.</p>"),
            ],
            nested_toc=True,
        )
        book = extract_epub(path)
        assert [c.title for c in book.chapters] == [
            "Chapter One",
            "Chapter Two",
            "Chapter Three",
        ]
        assert "First prose paragraph." in book.chapters[0].text

    def test_scripts_images_and_footnote_backlinks_are_stripped(self, tmp_path: Path) -> None:
        path = tmp_path / "book.epub"
        body = (
            "<p>Real prose.</p>"
            '<script>var evil = "SCRIPTTEXT";</script>'
            "<style>.x { color: red }</style>"
            '<img src="images/pic.png" alt="IMAGETEXT"/>'
            '<p>See note<a href="#fn1"><sup>7</sup></a> here.</p>'
            '<a href="#note2" role="doc-noteref">2</a>'
        )
        build_epub(path, [("c1", "One", body)])
        text = all_text(extract_epub(path))
        assert "Real prose." in text
        assert "SCRIPTTEXT" not in text
        assert "color" not in text
        assert "IMAGETEXT" not in text
        assert "7" not in text  # footnote back-link number
        assert "note2" not in text

    def test_drm_epub_raises_with_exact_message(self, tmp_path: Path) -> None:
        path = tmp_path / "drm.epub"
        build_epub(path, [("c1", "One", "<p>x</p>")], drm=True)
        with pytest.raises(UnsupportedFormat) as excinfo:
            extract_epub(path)
        assert excinfo.value.code == "drm"
        assert str(excinfo.value) == DRM_MESSAGE

    def test_embedded_metadata(self, tmp_path: Path) -> None:
        path = tmp_path / "book.epub"
        build_epub(path, [("c1", "One", "<p>x</p>")])
        meta = extract_epub(path).metadata
        assert meta.title == "Test Title"
        assert meta.authors == ["Test Author"]
        assert meta.language == "en"
        assert meta.publisher == "Test Publisher"
        assert meta.published_date == "2016-01-05"
        assert meta.description == "A test book."
        assert meta.isbn13 == "9781455540381"
        assert meta.tags == ["Testing"]

    def test_embedded_cover(self, tmp_path: Path) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (60, 90), (1, 2, 3)).save(buf, "JPEG")
        path = tmp_path / "book.epub"
        build_epub(path, [("c1", "One", "<p>x</p>")], cover=buf.getvalue())
        cover = extract_epub(path).cover
        assert cover is not None
        assert Image.open(io.BytesIO(cover)).size == (60, 90)


class TestPdf:
    def test_outline_titles_become_chapters(self, tmp_path: Path) -> None:
        path = tmp_path / "outline.pdf"
        make_text_pdf(path, 6, toc=[[1, "Chapter One", 1], [1, "Chapter Two", 4]])
        book = extract_pdf(path)
        assert [c.title for c in book.chapters] == ["Chapter One", "Chapter Two"]
        assert "page 0" in book.chapters[0].text
        assert "page 3" in book.chapters[1].text
        assert "page 4" not in book.chapters[0].text

    def test_flat_pdf_splits_into_20_page_chunks(self, tmp_path: Path) -> None:
        path = tmp_path / "flat.pdf"
        make_text_pdf(path, 24)
        book = extract_pdf(path)
        assert len(book.chapters) == 2
        assert "page 0" in book.chapters[0].text
        assert "page 19" in book.chapters[0].text
        assert "page 20" in book.chapters[1].text

    def test_repeated_footer_is_removed(self, tmp_path: Path) -> None:
        path = tmp_path / "footer.pdf"
        make_text_pdf(path, 20, footer="Sample Book - page footer line")
        text = all_text(extract_pdf(path))
        assert "Sample Book - page footer line" not in text
        assert "Unique body text for page 7" in text

    def test_scanned_pdf_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "scanned.pdf"
        make_image_pdf(path, 3)
        with pytest.raises(ScannedPDF):
            extract_pdf(path)

    def test_cover_from_first_embedded_image(self, tmp_path: Path) -> None:
        png = tmp_path / "cover.png"
        Image.new("RGB", (60, 90), (4, 5, 6)).save(png)
        path = tmp_path / "img.pdf"
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_image(pymupdf.Rect(72, 72, 200, 300), filename=str(png))
        for i in range(2):
            text_page = doc.new_page()
            for row in range(8):
                text_page.insert_text(
                    (72, 100 + row * 20), f"Unique body text for page {i}, line {row}, of the book."
                )
        doc.save(path)
        doc.close()
        png.unlink()
        cover = extract_pdf(path).cover
        assert cover is not None
        with Image.open(io.BytesIO(cover)) as img:
            assert img.size == (60, 90)

    def test_cover_rendered_from_page_one_when_no_image(self, tmp_path: Path) -> None:
        path = tmp_path / "text.pdf"
        make_text_pdf(path, 2)
        book = extract_pdf(path)
        assert book.cover is not None
        with Image.open(io.BytesIO(book.cover)) as img:
            assert abs(img.width / img.height - 2 / 3) < 0.05

    def test_metadata_from_document_info(self, tmp_path: Path) -> None:
        path = tmp_path / "meta.pdf"
        make_text_pdf(
            path, 1, metadata={"title": "PDF Title", "author": "PDF Author", "subject": "A subject"}
        )
        meta = extract_pdf(path).metadata
        assert meta.title == "PDF Title"
        assert meta.authors == ["PDF Author"]
        assert meta.description == "A subject"


class TestKindle:
    def test_kfx_is_rejected_before_conversion(self, tmp_path: Path) -> None:
        path = tmp_path / "book.kfx"
        path.write_bytes(b"\xeaDRMION\xee" + b"\x00" * 200)
        with pytest.raises(UnsupportedFormat) as excinfo:
            extract_kindle(path, tmp_path / "work")
        assert excinfo.value.code == "kfx"
        assert str(excinfo.value) == DRM_MESSAGE

    def test_non_kindle_input_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "notes.txt"
        path.write_bytes(b"hello")
        with pytest.raises(UnsupportedFormat) as excinfo:
            extract_kindle(path, tmp_path / "work")
        assert excinfo.value.code == "unknown"

    @pytest.mark.skipif(
        shutil.which("ebook-convert") is None, reason="Calibre (ebook-convert) not installed"
    )
    def test_azw3_roundtrip(self, tmp_path: Path) -> None:
        src = tmp_path / "book.epub"
        build_epub(src, [("c1", "Chapter One", "<p>Kindle prose here.</p>")])
        azw3 = tmp_path / "book.azw3"
        subprocess.run(
            ["ebook-convert", str(src), str(azw3)],
            check=True,
            timeout=300,
            capture_output=True,
        )
        book = extract_kindle(azw3, tmp_path / "work")
        assert book.chapters[0].title == "Chapter One"
        assert "Kindle prose here." in book.chapters[0].text
