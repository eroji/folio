"""Text preparation for speech: abbreviations, footnotes, URLs, whitespace."""

from __future__ import annotations

from folio.tts import normalize_speech_text, prepare_for_speech


def test_collapses_whitespace() -> None:
    assert normalize_speech_text("  too   many\n\nspaces\t here ") == "too many spaces here"


def test_expands_honorifics_before_a_name() -> None:
    assert normalize_speech_text("Dr. Frankenstein met Mr. Hyde.") == (
        "Doctor Frankenstein met Mister Hyde."
    )
    assert normalize_speech_text("Mrs. Danvers and Ms. Kerr and Prof. Armitage") == (
        "Mistress Danvers and Miss Kerr and Professor Armitage"
    )


def test_honorific_not_before_a_name_is_left_alone() -> None:
    # "safe positions" only: a mid-sentence abbreviation with no name is untouched.
    assert normalize_speech_text("He earned his Ph.D. and the Dr. rested.") == (
        "He earned his Ph.D. and the Dr. rested."
    )


def test_expands_latin_abbreviations() -> None:
    assert normalize_speech_text("fruits, e.g. apples, i.e. pome") == (
        "fruits, for example apples, that is pome"
    )


def test_drops_bracketed_footnote_markers() -> None:
    assert normalize_speech_text("as shown[12] earlier[7] in [3] the text.") == (
        "as shown earlier in the text."
    )


def test_replaces_urls_with_link() -> None:
    assert normalize_speech_text("see https://example.com/a?b=1 for more") == ("see link for more")
    assert "http" not in normalize_speech_text("http://x.io end")


def test_never_returns_empty_for_non_empty_input() -> None:
    assert normalize_speech_text("[42]") != ""
    assert normalize_speech_text("   \t\n  ") == ""  # whitespace-only input stays empty


def test_prepare_for_speech_is_the_same_function() -> None:
    assert prepare_for_speech is normalize_speech_text
