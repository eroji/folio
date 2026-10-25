"""Task B: metadata matching — normalization, similarity and the auto/candidate rule."""

from __future__ import annotations

import pytest

from folio.metadata import Candidate, match
from folio.models import Book


def _book(**overrides: object) -> Book:
    fields: dict[str, object] = {
        "title": "The Lord of the Rings",
        "authors": ["J. R. R. Tolkien"],
        "isbn13": None,
        "isbn10": None,
        **overrides,
    }
    return Book(**fields)  # type: ignore[arg-type]


def test_normalize_folds_case_punctuation_and_whitespace() -> None:
    assert match.normalize("The  Lord, of the RINGS!") == "the lord of the rings"
    assert match.normalize(None) == ""
    assert match.normalize("   ") == ""


def test_normalize_isbn_strips_separators_and_uppercases() -> None:
    assert match.normalize_isbn("978-0-306-40615-7") == "9780306406157"
    assert match.normalize_isbn("0-306-40615-2") == "0306406152"
    assert match.normalize_isbn("030640615x") == "030640615X"
    assert match.normalize_isbn(None) == ""


def test_title_is_weighted_higher_than_first_author() -> None:
    # The same differing pair, used once as the title and once as the author:
    # a title mismatch must move the score more than an author mismatch.
    title_differs = match.similarity("aaa", "aab", "same", "same")
    author_differs = match.similarity("same", "same", "aaa", "aab")
    assert author_differs > title_differs


def test_similarity_is_one_for_identical_title_and_author() -> None:
    assert match.similarity("Same", "same.", "Ann", "Ann") == pytest.approx(1.0)


def test_score_candidate_uses_the_first_author_only() -> None:
    book = _book(authors=["Ann", "Bob"])
    candidate = Candidate(id="x", source="openlibrary", title=book.title, authors=["Ann", "Zed"])
    assert match.score_candidate(book, candidate) == pytest.approx(1.0)


def test_decide_isbn13_match_wins_over_a_different_title() -> None:
    book = _book(isbn13="9780306406157")
    candidate = Candidate(
        id="x",
        source="openlibrary",
        title="Something Else Entirely",
        authors=["Nobody"],
        isbn13="978-0-306-40615-7",
    )
    assert match.decide(book, candidate) == "auto"


def test_decide_isbn10_match_is_auto() -> None:
    book = _book(isbn10="0306406152", authors=["X"])
    candidate = Candidate(id="x", source="openlibrary", title="Whatever", isbn10="0-306-40615-2")
    assert match.decide(book, candidate) == "auto"


def test_decide_auto_at_or_above_nine_tenths() -> None:
    book = _book()
    candidate = Candidate(
        id="x", source="openlibrary", title="The Lord Of The Rings", authors=["J. R. R. Tolkien"]
    )
    assert match.score_candidate(book, candidate) >= 0.9
    assert match.decide(book, candidate) == "auto"


def test_decide_candidate_below_nine_tenths() -> None:
    book = _book()
    candidate = Candidate(
        id="x", source="openlibrary", title="The Two Towers", authors=["J. R. R. Tolkien"]
    )
    assert match.score_candidate(book, candidate) < 0.9
    assert match.decide(book, candidate) == "candidate"


def test_decide_threshold_is_inclusive(monkeypatch: pytest.MonkeyPatch) -> None:
    book = _book()

    def fixed(value: float) -> object:
        return lambda _b, _c: value

    monkeypatch.setattr(match, "score_candidate", fixed(0.9))
    assert match.decide(book, Candidate(id="x", source="s")) == "auto"
    monkeypatch.setattr(match, "score_candidate", fixed(0.8999))
    assert match.decide(book, Candidate(id="x", source="s")) == "candidate"
