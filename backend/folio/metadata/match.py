"""Similarity and the auto/candidate decision (spec: Metadata → Sources).

Two rules, both cheap and dependency-free:

* ``similarity`` weights title 0.7 and first author 0.3 over ``difflib``
  ``SequenceMatcher`` ratios of normalized strings.
* ``decide`` auto-applies only on a normalized ISBN match or a score of at
  least 0.9; anything else is a candidate for human review.
"""

import re
from difflib import SequenceMatcher
from typing import Literal

from folio.metadata import Candidate
from folio.models import Book

AUTO_THRESHOLD = 0.9
_TITLE_WEIGHT = 0.7
_AUTHOR_WEIGHT = 0.3

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_NON_ISBN = re.compile(r"[^0-9xX]")


def normalize(text: str | None) -> str:
    """Lowercase, drop punctuation, collapse runs of whitespace to one space."""
    return _NON_ALNUM.sub(" ", (text or "").lower()).strip()


def normalize_isbn(isbn: str | None) -> str:
    """Strip separators, uppercase the ISBN-10 check digit; '' when unusable."""
    return _NON_ISBN.sub("", isbn or "").upper()


def first_author(authors: list[str] | None) -> str:
    return authors[0] if authors else ""


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def similarity(title_a: str | None, title_b: str | None, author_a: str, author_b: str) -> float:
    """0.7 × title ratio + 0.3 × first-author ratio, on normalized strings."""
    return _TITLE_WEIGHT * _ratio(normalize(title_a), normalize(title_b)) + _AUTHOR_WEIGHT * _ratio(
        normalize(author_a), normalize(author_b)
    )


def score_candidate(book: Book, candidate: Candidate) -> float:
    """Similarity between a book and one candidate (title + first author)."""
    return similarity(
        book.title, candidate.title, first_author(book.authors), first_author(candidate.authors)
    )


def isbn_match(book: Book, candidate: Candidate) -> bool:
    book13, cand13 = normalize_isbn(book.isbn13), normalize_isbn(candidate.isbn13)
    book10, cand10 = normalize_isbn(book.isbn10), normalize_isbn(candidate.isbn10)
    return (bool(book13) and book13 == cand13) or (bool(book10) and book10 == cand10)


def decide(book: Book, candidate: Candidate) -> Literal["auto", "candidate"]:
    """ISBN match wins outright; otherwise auto only at ``AUTO_THRESHOLD``."""
    if isbn_match(book, candidate):
        return "auto"
    return "auto" if score_candidate(book, candidate) >= AUTO_THRESHOLD else "candidate"
