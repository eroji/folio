"""Text cleaning for speech: NFKC, de-hyphenation, whitespace, invisible characters."""

from dataclasses import dataclass

from folio.ingest.clean import clean_chapters, clean_text


@dataclass
class Chapter:
    """Stand-in for T5a's ExtractedChapter (duck-typed on .title/.text)."""

    title: str
    text: str


def test_nfkc_normalises_ligatures_and_fullwidth() -> None:
    assert clean_text("ﬁx", "en") == "fix"
    assert clean_text("Ⅻ century", "en") == "XII century"
    assert clean_text("ＡＢ code", "en") == "AB code"


def test_dehyphenates_line_breaks() -> None:
    assert clean_text("this is an exam-\nple of hyphenation", "en") == (
        "this is an example of hyphenation"
    )
    assert clean_text("a better under-\nstanding of books", "en") == (
        "a better understanding of books"
    )


def test_hyphen_before_capital_keeps_hyphen_without_gap() -> None:
    assert clean_text("the Gross-\nBaum family", "en") == "the Gross-Baum family"


def test_hyphen_at_paragraph_break_is_kept() -> None:
    assert clean_text("well-\n\nknown fact", "en") == "well-\n\nknown fact"


def test_collapses_whitespace_but_keeps_paragraph_breaks() -> None:
    raw = "Line one   with\ttabs.\nNext line.\n\n\n\nSecond paragraph.  "
    assert clean_text(raw, "en") == "Line one with tabs. Next line.\n\nSecond paragraph."


def test_single_newlines_become_spaces() -> None:
    assert clean_text("a\nb\nc", "en") == "a b c"


def test_strips_zero_width_and_soft_hyphen() -> None:
    assert clean_text("a\u200bb\u200cc\u200dd\ufeffe\u2060f", "en") == "abcdef"
    assert clean_text("re\u00adsume", "en") == "resume"


def test_normalises_crlf_and_trailing_whitespace() -> None:
    assert clean_text("a  \r\nb\r", "en") == "a b"


def test_clean_chapters_preserves_type_title_and_cleans_text() -> None:
    chapters = [Chapter("Ch 1", "exam-\nple  text"), Chapter("Ch 2", "   \n  ")]
    cleaned = clean_chapters(chapters, "en")
    assert all(isinstance(c, Chapter) for c in cleaned)
    assert [c.title for c in cleaned] == ["Ch 1", "Ch 2"]
    assert cleaned[0].text == "example text"
    assert cleaned[1].text == ""
