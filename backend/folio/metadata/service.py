"""Metadata service: merge providers, apply a candidate, and the ingest hook.

``search_book`` powers the interactive "Find metadata" panel, ``apply_candidate``
writes a human's chosen fields (skipping anything in ``locked_fields``), and
``auto_fetch`` is what the ingest pipeline calls after embedded metadata: it
auto-applies a confident match or saves everything as review candidates, and
grabs a cover when the book has none.
"""

import logging
import math
from collections.abc import Iterable
from dataclasses import asdict
from typing import Any

import bleach  # type: ignore[import-untyped]
import httpx
from sqlalchemy.orm import Session

from folio.config import GENRES, Settings
from folio.covers import DOWNLOAD_TIMEOUT_S, MAX_REDIRECTS, download_cover, store_cover
from folio.errors import ApiError
from folio.metadata import Candidate, googlebooks, openlibrary
from folio.metadata.match import decide as decide_match
from folio.metadata.match import (
    first_author,
    isbn_match,
    normalize,
    normalize_isbn,
    score_candidate,
)
from folio.models import Book, MetadataCandidate
from folio.text import clean_description

logger = logging.getLogger(__name__)

# Fields auto_fetch may write; cover_url is handled separately and subtitle /
# narrator_voice have no provider source. genre is derived from subjects below.
AUTO_FIELDS = [
    "title",
    "authors",
    "series",
    "series_index",
    "description",
    "publisher",
    "published_date",
    "language",
    "isbn10",
    "isbn13",
    "tags",
    "genre",
]

#: The only fields a client may ask the apply endpoint to write.
EDITABLE_FIELDS = frozenset([*AUTO_FIELDS, "cover_url"])

#: Lowercased subject strings that map onto a GENRES entry: every genre name
#: itself plus the Open Library / Google Books subjects we recognize.
_GENRE_ALIASES: dict[str, str] = {g.lower(): g for g in GENRES}
_GENRE_ALIASES.update(
    {
        "classic": "Classics",
        "fiction": "Fiction",
        "literary": "Fiction",
        "sci-fi": "Science Fiction",
        "science fiction and fantasy": "Science Fiction",
        "fantasy fiction": "Fantasy",
        "mystery": "Mystery",
        "crime": "Mystery",
        "detective": "Mystery",
        "crime fiction": "Mystery",
        "detective and mystery stories": "Mystery",
        "mystery fiction": "Mystery",
        "thriller": "Thriller",
        "thrillers": "Thriller",
        "suspense": "Thriller",
        "spy fiction": "Thriller",
        "espionage": "Thriller",
        "gothic": "Horror",
        "gothic fiction": "Horror",
        "horror": "Horror",
        "horror tales": "Horror",
        "ghost stories": "Horror",
        "love stories": "Romance",
        "mythology": "Myth & epic",
        "myths": "Myth & epic",
        "epics": "Myth & epic",
        "epic poems": "Myth & epic",
        "poems": "Poetry",
        "verse": "Poetry",
        "plays": "Drama",
        "autobiography": "Biography",
        "memoirs": "Biography",
        "biography and autobiography": "Biography",
        "non-fiction": "Nonfiction",
        "essays": "Nonfiction",
        "juvenile fiction": "Children",
        "juvenile literature": "Children",
        "children's fiction": "Children",
        "children's stories": "Children",
    }
)
# Longest first so "science fiction" wins over "fiction" inside a subject.
_ALIASES_BY_LENGTH = sorted(_GENRE_ALIASES, key=lambda alias: (-len(alias), alias))


def genre_from_subjects(subjects: Iterable[str]) -> str | None:
    """Map the first recognizable subject to a genre from GENRES; else None."""
    for subject in subjects:
        text = subject.strip().lower()
        if not text:
            continue
        if text in _GENRE_ALIASES:
            return _GENRE_ALIASES[text]
        for alias in _ALIASES_BY_LENGTH:
            if alias in text:
                return _GENRE_ALIASES[alias]
    return None


# Column widths for provider strings we write straight to the model.
_LIMITS = {
    "title": 512,
    "series": 255,
    "publisher": 255,
    "published_date": 32,
    "language": 16,
}


def _fit(name: str, value: str) -> str:
    return value[: _LIMITS[name]] if name in _LIMITS else value


def _clean_list(values: object) -> list[str] | None:
    items = values if isinstance(values, list) else []
    cleaned = [v.strip() for v in items if isinstance(v, str) and v.strip()]
    return list(dict.fromkeys(cleaned)) or None


def _to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _field_value(candidate: Candidate, name: str) -> object | None:
    """Coerce one candidate field to a value safe for the ``Book`` column."""
    if name == "description":
        raw = candidate.description or ""
        return clean_description(bleach.clean(raw, tags=[], strip=True).strip()) or None
    if name in ("authors", "tags"):
        return _clean_list(getattr(candidate, name))
    if name == "genre":
        return genre_from_subjects(candidate.tags)
    if name == "series_index":
        return _to_float(candidate.series_index)
    if name in ("isbn10", "isbn13"):
        return normalize_isbn(getattr(candidate, name)) or None
    value = getattr(candidate, name, None)
    if isinstance(value, str):
        return _fit(name, value.strip()) or None
    return value


def _apply_cover(settings: Settings, book: Book, url: str, client: httpx.Client) -> bool:
    """Download and store a provider cover; False (logged) on any failure."""
    try:
        book.cover_key, book.cover_rgb = store_cover(settings, book.id, download_cover(url, client))
        return True
    except ApiError as exc:
        logger.warning("online cover for book %s failed: %s", book.id, exc.message)
        return False


def _fetch_cover(
    settings: Settings, book: Book, url: str, client: httpx.Client | None = None
) -> bool:
    """Fetch a provider cover; uses ``client`` when given (auto_fetch), else a
    throwaway one (the apply endpoint has no client of its own)."""
    if client is not None:
        return _apply_cover(settings, book, url, client)
    with httpx.Client(
        timeout=DOWNLOAD_TIMEOUT_S, follow_redirects=True, max_redirects=MAX_REDIRECTS
    ) as own:
        return _apply_cover(settings, book, url, own)


def _dedupe(candidates: list[Candidate]) -> list[Candidate]:
    """Keep the best candidate per ISBN, else per normalized title + first author."""
    best: dict[Any, Candidate] = {}
    for candidate in candidates:
        key = (
            normalize_isbn(candidate.isbn13)
            or normalize_isbn(candidate.isbn10)
            or (normalize(candidate.title), normalize(first_author(candidate.authors)))
        )
        if key not in best or candidate.score > best[key].score:
            best[key] = candidate
    return sorted(best.values(), key=lambda candidate: candidate.score, reverse=True)


def search_book(
    settings: Settings, query: str | None, isbn: str | None, client: httpx.Client
) -> list[Candidate]:
    """Search both providers and return merged, deduped, score-sorted candidates."""
    if not settings.metadata_online:
        return []
    merged = openlibrary.search(query, isbn, client) + googlebooks.search(query, isbn, client)
    return _dedupe(merged)


def apply_candidate(
    session: Session,
    book: Book,
    candidate: Candidate,
    fields: list[str],
    settings: Settings,
    respect_locks: bool = True,
    client: httpx.Client | None = None,
) -> list[str]:
    """Write only the requested, editable fields; return the names applied.

    ``fields`` comes from the client, so anything outside the metadata columns
    (``id``, ``status``, ``cover_key``…) is ignored rather than setattr'd.
    ``respect_locks`` is False for an explicit user apply — the UI may re-apply
    a field the user previously locked; automatic fetches keep it True.

    Descriptions are sanitized to plain text; a requested ``cover_url`` is
    fetched and stored (a failed download is logged, not raised, so the rest of
    the apply still lands). A candidate cover is also fetched automatically
    when the book has none, even if the client did not ask for the field.
    """
    applied: list[str] = []
    cover_requested = "cover_url" in fields
    for name in fields:
        if name not in EDITABLE_FIELDS:
            continue
        if respect_locks and name in book.locked_fields:
            continue
        if name == "cover_url":
            if not candidate.cover_url:
                continue
            if _fetch_cover(settings, book, candidate.cover_url, client):
                applied.append("cover_url")
            continue
        value = _field_value(candidate, name)
        if value is None:
            continue
        setattr(book, name, value)
        applied.append(name)
    if (
        not cover_requested
        and book.cover_key is None
        and candidate.cover_url
        and _fetch_cover(settings, book, candidate.cover_url, client)
    ):
        applied.append("cover_url")
    session.commit()
    return applied


def auto_fetch(session: Session, settings: Settings, book: Book, client: httpx.Client) -> None:
    """Best-effort online metadata for one book during ingest.

    Search by ISBN when the book has one, else by title + first author. An auto
    match is applied (locked fields are skipped by ``apply_candidate``);
    otherwise every candidate is persisted for review. When the book still has
    no cover, the chosen/expected candidate's cover URL is downloaded.
    """
    isbn = book.isbn13 or book.isbn10
    query = None if isbn else f"{book.title} {first_author(book.authors)}".strip()
    candidates = search_book(settings, query, isbn, client)
    if not candidates:
        return
    for candidate in candidates:
        candidate.score = score_candidate(book, candidate)
    auto = [candidate for candidate in candidates if decide_match(book, candidate) == "auto"]
    if auto:
        target = max(auto, key=lambda c: (isbn_match(book, c), c.score))
        apply_candidate(session, book, target, AUTO_FIELDS, settings, client=client)
    else:
        for candidate in candidates:
            session.add(
                MetadataCandidate(
                    book_id=book.id,
                    source=candidate.source,
                    payload=asdict(candidate),
                    score=candidate.score,
                )
            )
        session.commit()
        target = max(candidates, key=lambda c: c.score)
    if (
        book.cover_key is None
        and target.cover_url
        and _apply_cover(settings, book, target.cover_url, client)
    ):
        session.commit()
