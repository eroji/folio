"""clean_description: strip the invisible characters that render as empty boxes."""

from __future__ import annotations

from folio.ingest import EmbeddedMetadata
from folio.ingest.pipeline import _apply_metadata
from folio.models import Book
from folio.text import clean_description, description_text


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


def test_description_text_decodes_html_entities() -> None:
    # bleach leaves entities escaped; React shows them literally (&ldquo;).
    raw = "<p>He said &ldquo;hi&rdquo; &mdash; Tom &amp; Jerry&#8217;s &#x2014; ok</p>"
    assert description_text(raw) == "He said \u201chi\u201d \u2014 Tom & Jerry\u2019s \u2014 ok"


def test_description_text_keeps_a_bare_angle_bracket_as_text() -> None:
    assert description_text("a < b and c > d") == "a < b and c > d"


def test_description_text_strips_double_encoded_markup() -> None:
    # Some OPFs escape their HTML twice; the decoded tags are markup too.
    raw = "&lt;p&gt;One &amp;amp; two &amp;ldquo;q&amp;rdquo;&lt;/p&gt;"
    assert description_text(raw) == "One & two \u201cq\u201d"


def test_description_text_keeps_paragraph_and_line_breaks() -> None:
    raw = "<p>One.</p>\n<p>Two.<br>Next<BR/>line.</p><div>Three.</div>"
    assert description_text(raw) == "One.\n\nTwo.\nNext\nline.\n\nThree."


def test_description_text_still_drops_invisible_characters() -> None:
    assert description_text("<b>a</b>\xa0b\x9dc&nbsp;d") == "a bc d"
    assert description_text("") == ""


def test_apply_metadata_decodes_entities_in_the_embedded_description() -> None:
    book = Book(title="x", language="en", locked_fields=[])
    _apply_metadata(book, EmbeddedMetadata(description="<p>&ldquo;Q&rdquo; &mdash; A</p>"))
    assert book.description == "\u201cQ\u201d \u2014 A"
