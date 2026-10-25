"""Open Library provider (spec: Metadata → Sources, no key required).

Two endpoints: ``/isbn/{isbn}.json`` for a precise edition match and
``/search.json?q=`` for a title/author search. Covers are rebuilt from the
``cover_i`` / ``covers`` id as ``https://covers.openlibrary.org/b/id/<id>-L.jpg``.
"""

from typing import Any

import httpx

from folio.metadata import Candidate, get_json

SEARCH_URL = "https://openlibrary.org/search.json"
ISBN_URL = "https://openlibrary.org/isbn/{isbn}.json"
COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"
_LIMIT = "20"

# Open Library uses ISO 639-2 codes; map the ones Folio's voices understand and
# pass anything else through unchanged (a wrong code only affects voice choice).
_LANGUAGES = {
    "eng": "en",
    "ger": "de",
    "fre": "fr",
    "spa": "es",
    "ita": "it",
    "por": "pt",
    "jpn": "ja",
    "kor": "ko",
    "chi": "zh",
    "zho": "zh",
}


def _cover(cover_id: Any) -> str | None:
    return COVER_URL.format(cover_id=cover_id) if cover_id else None


def _language(codes: list[str]) -> str | None:
    return _LANGUAGES.get(codes[0], codes[0]) if codes else None


def _split_isbns(values: list[str]) -> tuple[str | None, str | None]:
    isbn13 = next((v for v in values if len(v.replace("-", "")) == 13), None)
    isbn10 = next((v for v in values if len(v.replace("-", "")) == 10), None)
    return isbn10, isbn13


def _text(value: Any) -> str | None:
    """OL description/notes may be a plain string or ``{"value": ...}``."""
    if isinstance(value, dict):
        value = value.get("value")
    return str(value) if value else None


def _from_doc(doc: dict[str, Any]) -> Candidate:
    isbn10, isbn13 = _split_isbns([str(i) for i in doc.get("isbn", [])])
    year = doc.get("first_publish_year")
    publishers = doc.get("publisher", [])
    series = doc.get("series", [])
    return Candidate(
        id=str(doc.get("key", "")),
        source="openlibrary",
        title=doc.get("title"),
        authors=[str(a) for a in doc.get("author_name", [])],
        published_date=str(year) if year else None,
        publisher=str(publishers[0]) if publishers else None,
        language=_language([str(c) for c in doc.get("language", [])]),
        isbn10=isbn10,
        isbn13=isbn13,
        series=str(series[0]) if series else None,
        tags=[str(s) for s in doc.get("subject", [])],
        cover_url=_cover(doc.get("cover_i")),
    )


def _from_edition(isbn: str, edition: dict[str, Any]) -> Candidate:
    isbn10 = edition.get("isbn_10", [None])[0]
    isbn13 = edition.get("isbn_13", [None])[0]
    authors = [
        a["name"] for a in edition.get("authors", []) if isinstance(a, dict) and a.get("name")
    ]
    publishers = edition.get("publishers", [])
    series = edition.get("series", [])
    covers = edition.get("covers", [])
    languages = [
        str(lang.get("key", "").rsplit("/", 1)[-1]) for lang in edition.get("languages", [])
    ]
    return Candidate(
        id=str(edition.get("key", "")),
        source="openlibrary",
        title=edition.get("title"),
        authors=authors,
        published_date=_text(edition.get("publication_date")),
        publisher=str(publishers[0]) if publishers else None,
        description=_text(edition.get("description") or edition.get("notes")),
        language=_language(languages),
        isbn10=str(isbn10) if isbn10 else isbn if len(isbn) == 10 else None,
        isbn13=str(isbn13) if isbn13 else isbn if len(isbn) == 13 else None,
        series=str(series[0]) if series else None,
        tags=[str(s) for s in edition.get("subjects", [])],
        cover_url=_cover(covers[0] if covers else None),
    )


def search(query: str | None, isbn: str | None, client: httpx.Client) -> list[Candidate]:
    """Precise ISBN edition lookup plus a title/author search, merged."""
    candidates: list[Candidate] = []
    if isbn:
        edition = get_json(client, ISBN_URL.format(isbn=isbn))
        if isinstance(edition, dict) and edition.get("title"):
            candidates.append(_from_edition(isbn, edition))
    if query:
        found = get_json(client, SEARCH_URL, {"q": query, "limit": _LIMIT})
        if isinstance(found, dict):
            candidates.extend(_from_doc(doc) for doc in found.get("docs", []) if "title" in doc)
    return candidates
