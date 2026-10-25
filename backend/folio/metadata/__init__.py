"""Online metadata providers: the shared ``Candidate`` shape, provider protocol and
a safe JSON GET helper.

A provider turns one source's JSON (Open Library, Google Books) into a list of
``Candidate`` objects. Normalisation is deliberately lossy: every provider maps
its own field names onto the ``Book`` columns the candidate can fill, so the
matching layer (``match.py``) and the apply path (``service.py``) never need to
know which source produced a candidate.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)


def get_json(client: httpx.Client, url: str, params: dict[str, str] | None = None) -> Any | None:
    """GET ``url`` and parse JSON; ``None`` on any non-200, network or parse error.

    Providers must never raise at the caller: a flaky or rate-limited source is
    simply "no results" (spec + plan), so every failure is logged at warning and
    swallowed here.
    """
    try:
        response = client.get(url, params=params)
    except httpx.HTTPError as exc:
        logger.warning("metadata request to %s failed: %s", url, type(exc).__name__)
        return None
    if response.status_code != 200:
        logger.warning("metadata request to %s returned HTTP %s", url, response.status_code)
        return None
    try:
        return response.json()
    except ValueError:
        logger.warning("metadata response from %s was not valid JSON", url)
        return None


@dataclass
class Candidate:
    """One normalised online match, ready to score against a ``Book``."""

    id: str
    source: str
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    published_date: str | None = None
    publisher: str | None = None
    description: str | None = None
    language: str | None = None
    isbn10: str | None = None
    isbn13: str | None = None
    series: str | None = None
    series_index: float | None = None
    tags: list[str] = field(default_factory=list)
    cover_url: str | None = None
    score: float = 0.0


class Provider(Protocol):
    """A metadata source. ``isbn`` wins over ``query`` when both are given."""

    def search(
        self, query: str | None, isbn: str | None, client: httpx.Client
    ) -> list[Candidate]: ...
