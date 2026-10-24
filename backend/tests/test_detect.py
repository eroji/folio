"""detect_format by magic bytes. Self-contained: every fixture is built in tmp_path."""

import zipfile
from pathlib import Path

import pymupdf
import pytest

from folio.ingest.detect import Format, detect_format


def make_pdf(path: Path, pages: int = 1) -> None:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Body text for page {i}. " * 15)
    doc.save(path)
    doc.close()


def make_epub_zip(path: Path, mimetype: str = "application/epub+zip") -> None:
    """Minimal zip that detection only needs: a stored `mimetype` entry."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", mimetype, compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", "<container/>")


def test_pdf_renamed_to_epub_is_detected_as_pdf(tmp_path: Path) -> None:
    path = tmp_path / "sneaky.epub"
    make_pdf(path)
    assert detect_format(path) is Format.PDF


def test_real_epub_is_detected(tmp_path: Path) -> None:
    path = tmp_path / "book.epub"
    make_epub_zip(path)
    assert detect_format(path) is Format.EPUB


def test_zip_that_is_not_epub_is_unknown(tmp_path: Path) -> None:
    path = tmp_path / "other.epub"
    make_epub_zip(path, mimetype="text/plain")
    assert detect_format(path) is Format.UNKNOWN


def test_bookmobi_is_kindle(tmp_path: Path) -> None:
    path = tmp_path / "book.azw3"
    path.write_bytes(b"\x00" * 60 + b"BOOKMOBI" + b"\x00" * 100)
    assert detect_format(path) is Format.KINDLE


def test_kfx_magic_is_kfx(tmp_path: Path) -> None:
    path = tmp_path / "book.kfx"
    path.write_bytes(b"\xeaDRMION\xee" + b"\x00" * 200)
    assert detect_format(path) is Format.KFX


@pytest.mark.parametrize("content", [b"just a text file\n", b""])
def test_text_file_is_unknown(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "notes.txt"
    path.write_bytes(content)
    assert detect_format(path) is Format.UNKNOWN
