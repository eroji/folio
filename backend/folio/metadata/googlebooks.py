"""Google Books provider (spec: Metadata → Sources, optional API key).

``volumes?q=`` where ``q`` is the ISBN when we have one, else the title/author
query. On this network the endpoint returns 429 without a key, so every non-200,
timeout and parse failure is treated as "no results" (``get_json`` logs it at
warning and never raises) — Google Books is strictly best-effort.
"""

from typing import Any

import httpx

from folio.config import get_settings
from folio.metadata import Candidate, get_json

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


def search(query: str | None, isbn: str | None, client: httpx.Client) -> list[Candidate]:
    params: dict[str, str] = {"q": isbn or query or "", "maxResults": _LIMIT}
    if key := get_settings().google_books_api_key:
        params["key"] = key
    found = get_json(client, SEARCH_URL, params)
    if not isinstance(found, dict):
        return []
    items = (found.get("items") or [])[: int(_LIMIT)]
    return [c for item in items if (c := _from_item(item)) is not None]
