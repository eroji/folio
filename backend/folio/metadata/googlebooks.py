"""Google Books provider (spec: Metadata → Sources, optional API key).

``volumes?q=`` where ``q`` is the ISBN when we have one, else the title/author
query. Without an API key (Admin → Integrations, else GOOGLE_BOOKS_API_KEY) the
endpoint answers 429 most of the time; every non-200, timeout and parse failure
is "no results" (logged, never raised) — Google Books is strictly best-effort.
"""

import logging
import time
from typing import Any

import httpx

from folio.metadata import Candidate

logger = logging.getLogger(__name__)

SEARCH_URL = "https://www.googleapis.com/books/v1/volumes"
_LIMIT = "20"


def _cover(volume: dict[str, Any]) -> str | None:
    links = volume.get("imageLinks") or {}
    url = links.get("thumbnail") or links.get("smallThumbnail")
    if not url:
        return None
    # Thumbnails come back over http with an auth-bound ``edge=curl`` param.
    return str(url).replace("http://", "https://").replace("&edge=curl", "")


def _isbns(volume: dict[str, Any]) -> tuple[str | None, str | None]:
    isbn10 = isbn13 = None
    for ident in volume.get("industryIdentifiers", []) or []:
        if ident.get("type") == "ISBN_13":
            isbn13 = ident.get("identifier")
        elif ident.get("type") == "ISBN_10":
            isbn10 = ident.get("identifier")
    return isbn10, isbn13


def _from_item(item: dict[str, Any]) -> Candidate | None:
    volume = item.get("volumeInfo") or {}
    title = volume.get("title")
    if not title:
        return None
    isbn10, isbn13 = _isbns(volume)
    published = volume.get("publishedDate")
    return Candidate(
        id=str(item.get("id", "")),
        source="googlebooks",
        title=title,
        authors=[str(a) for a in volume.get("authors", [])],
        published_date=str(published)[:32] if published else None,
        publisher=volume.get("publisher"),
        description=volume.get("description"),
        language=volume.get("language"),
        isbn10=isbn10,
        isbn13=isbn13,
        tags=[str(c) for c in volume.get("categories", [])],
        cover_url=_cover(volume),
    )


# After a 429 Google is left alone for a while (process-wide): retrying at once
# only extends the block, and a reprocess burst would keep it there.
COOLDOWN_S = 300.0
_paused_until = 0.0


def _pause(response: httpx.Response) -> None:
    global _paused_until
    try:
        wait = float(response.headers.get("Retry-After", ""))
    except ValueError:
        wait = COOLDOWN_S
    _paused_until = time.monotonic() + max(wait, 1.0)


def search(
    query: str | None, isbn: str | None, client: httpx.Client, api_key: str = ""
) -> list[Candidate]:
    if time.monotonic() < _paused_until:
        logger.info("Google Books skipped: rate limited a moment ago")
        return []
    params: dict[str, str] = {"q": isbn or query or "", "maxResults": _LIMIT}
    if api_key:
        params["key"] = api_key
    try:
        response = client.get(SEARCH_URL, params=params)
    except httpx.HTTPError as exc:
        logger.warning("metadata request to %s failed: %s", SEARCH_URL, type(exc).__name__)
        return []
    if response.status_code == 429:
        _pause(response)
        logger.warning(
            "Google Books rate limited (HTTP 429)%s; pausing it",
            "" if api_key else " — no API key is set (Admin → Integrations)",
        )
        return []
    if response.status_code != 200:
        logger.warning("metadata request to %s returned HTTP %s", SEARCH_URL, response.status_code)
        return []
    try:
        found = response.json()
    except ValueError:
        return []
    if not isinstance(found, dict):
        return []
    items = (found.get("items") or [])[: int(_LIMIT)]
    return [c for item in items if (c := _from_item(item)) is not None]


def probe(client: httpx.Client, api_key: str) -> tuple[bool, str]:
    """One known lookup for the admin page's Test button: whether Google Books
    answers with this key (or without one), in words an admin can act on."""
    global _paused_until
    params = {"q": "isbn:9780141439518", "maxResults": "1"}
    if api_key:
        params["key"] = api_key
    try:
        response = client.get(SEARCH_URL, params=params)
    except httpx.HTTPError:
        return False, "Could not reach Google Books."
    body = response.text
    if response.status_code == 200:
        _paused_until = 0.0
        return True, "Google Books answered " + ("with this key." if api_key else "without a key.")
    if response.status_code == 400 and "API key" in body:
        return False, "Google rejected the API key."
    if response.status_code == 403:
        return False, "The key's Google Cloud project does not allow the Books API (HTTP 403)."
    if response.status_code == 429:
        hint = "the key's daily quota may be used up." if api_key else "set an API key."
        return False, f"Google Books is rate limiting requests (HTTP 429): {hint}"
    return False, f"Google Books returned HTTP {response.status_code}."
