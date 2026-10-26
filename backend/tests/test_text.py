"""clean_description: strip the invisible characters that render as empty boxes."""

from __future__ import annotations

from folio.ingest import EmbeddedMetadata
from folio.ingest.pipeline import _apply_metadata
from folio.models import Book
from folio.text import clean_description


def test_clean_description_strips_invisible_characters() -> None:
    assert clean_description("a\xa0b") == "a b"  # NBSP becomes a normal space
    assert clean_description("a\u200b\ufeff\u200c\u200db") == "ab"  # zero-width + BOM
    assert clean_description("a\ufffdb") == "ab"  # replacement character
    assert clean_description("a\x9db") == "ab"  # C1 control (the empty box)
    assert clean_description("a\x00\x1f\x7fb") == "ab"  # C0 controls
    assert clean_description("a\u2060\u00adb") == "ab"  # word joiner, soft hyphen


def test_clean_description_keeps_newlines_tabs_and_normal_text() -> None:
    text = "Line one.\nLine two:\ttab.\n\nPara — dash, é, 日本語, 😀."
    assert clean_description(text) == text
    assert clean_description("") == ""


def test_apply_metadata_cleans_the_embedded_description() -> None:
    book = Book(title="x", language="en", locked_fields=[])
    _apply_metadata(book, EmbeddedMetadata(description="<b>a</b>\xa0b\x9dc"))
    assert book.description == "a bc"
