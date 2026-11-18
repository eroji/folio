"""Task B: Open Library and Google Books providers — canned JSON, never the network."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.metadata import googlebooks, openlibrary


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# --- Open Library ------------------------------------------------------------


def test_openlibrary_search_normalizes_a_doc() -> None:
    body = {
        "numFound": 1,
        "docs": [
            {
                "key": "/works/OL1W",
                "title": "Project Gutenberg",
                "author_name": ["Alice"],
                "first_publish_year": 2001,
                "publisher": ["PG Press"],
                "cover_i": 123,
                "language": ["eng"],
                "isbn": ["9781111111117", "111111111X"],
                "subject": ["classics"],
                "series": ["Gut Series"],
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "openlibrary.org"
        assert request.url.path == "/search.json"
        assert request.url.params["q"] == "Project Gutenberg"
        return httpx.Response(200, json=body)

    (candidate,) = openlibrary.search("Project Gutenberg", None, _client(handler))
    assert candidate.source == "openlibrary"
    assert candidate.id == "/works/OL1W"
    assert candidate.title == "Project Gutenberg"
    assert candidate.authors == ["Alice"]
    assert candidate.published_date == "2001"
    assert candidate.publisher == "PG Press"
    assert candidate.language == "en"
    assert candidate.isbn13 == "9781111111117"
    assert candidate.isbn10 == "111111111X"
    assert candidate.series == "Gut Series"
    assert candidate.tags == ["classics"]
    assert candidate.cover_url == "https://covers.openlibrary.org/b/id/123-L.jpg"


def test_openlibrary_isbn_endpoint_normalizes_an_edition() -> None:
    body = {
        "key": "/books/OL2B",
        "title": "Edition Title",
        "authors": [{"key": "/authors/OL3A", "name": "Bob"}],
        "publishers": ["Edition Press"],
        "publication_date": "2010",
        "covers": [456],
        "isbn_13": ["9782222222222"],
        "languages": [{"key": "/languages/jpn"}],
        "subjects": ["fiction"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/isbn/9782222222222.json"
        return httpx.Response(200, json=body)

    (candidate,) = openlibrary.search(None, "9782222222222", _client(handler))
    assert candidate.title == "Edition Title"
    assert candidate.authors == ["Bob"]
    assert candidate.isbn13 == "9782222222222"
    assert candidate.isbn10 is None
    assert candidate.published_date == "2010"
    assert candidate.language == "ja"
    assert candidate.cover_url == "https://covers.openlibrary.org/b/id/456-L.jpg"


# --- Google Books ------------------------------------------------------------


def test_googlebooks_normalizes_a_volume() -> None:
    body = {
        "totalItems": 1,
        "items": [
            {
                "id": "abc",
                "volumeInfo": {
                    "title": "G Title",
                    "authors": ["Ann"],
                    "publisher": "GP",
                    "publishedDate": "2005-01-01",
                    "description": "<b>hi</b>",
                    "language": "en",
                    "industryIdentifiers": [
                        {"type": "ISBN_13", "identifier": "9783333333333"},
                        {"type": "ISBN_10", "identifier": "3333333333"},
                    ],
                    "categories": ["cat"],
                    "imageLinks": {"thumbnail": "http://books.google.com/x?img=1&edge=curl&zoom=1"},
                },
            }
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "www.googleapis.com"
        assert request.url.params["q"] == "G Title"
        assert "key" not in request.url.params
        return httpx.Response(200, json=body)

    (candidate,) = googlebooks.search("G Title", None, _client(handler))
    assert candidate.source == "googlebooks"
    assert candidate.title == "G Title"
    assert candidate.isbn13 == "9783333333333"
    assert candidate.isbn10 == "3333333333"
    assert candidate.published_date == "2005-01-01"
    # description is passed through raw; sanitization happens on apply, not here
    assert candidate.description == "<b>hi</b>"
    assert candidate.cover_url is not None
    assert candidate.cover_url.startswith("https://")
    assert "edge=curl" not in candidate.cover_url


def test_googlebooks_searches_by_isbn_and_sends_the_key() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["q"] = request.url.params["q"]
        seen["key"] = request.url.params.get("key")
        return httpx.Response(200, json={"items": []})

    assert googlebooks.search("ignored", "9781111111117", _client(handler), "SECRET") == []
    assert seen == {"q": "9781111111117", "key": "SECRET"}


# --- Both providers degrade to "no results" ----------------------------------


@pytest.mark.parametrize("provider", [openlibrary, googlebooks], ids=["ol", "gb"])
def test_provider_http_errors_are_no_results(provider: Any) -> None:
    for status in (429, 500, 404):

        def handler(request: httpx.Request, _s: int = status) -> httpx.Response:
            return httpx.Response(_s, json={"error": "nope"})

        assert provider.search("q", None, _client(handler)) == []


@pytest.mark.parametrize("provider", [openlibrary, googlebooks], ids=["ol", "gb"])
def test_provider_timeout_and_bad_json_are_no_results(provider: Any) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("down", request=request)

    def bad_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    assert provider.search("q", None, _client(timeout)) == []
    assert provider.search("q", None, _client(bad_json)) == []


def test_googlebooks_429_logs_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={})

    import logging

    with caplog.at_level(logging.WARNING, logger="folio.metadata"):
        assert googlebooks.search("q", None, _client(handler)) == []
    assert any("429" in record.message for record in caplog.records)


# --- Google Books: API key and rate-limit pause ------------------------------


def test_google_sends_the_key_and_pauses_after_a_429() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "120"}, json={"error": {"code": 429}})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert googlebooks.search("Dune", None, client, "my-key") == []
    assert calls[0].url.params["key"] == "my-key"
    # Paused: the next searches do not even ask.
    assert googlebooks.search("Emma", None, client, "my-key") == []
    assert len(calls) == 1
    # A successful Test clears the pause.
    ok_client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"totalItems": 1}))
    )
    assert googlebooks.probe(ok_client, "my-key") == (True, "Google Books answered with this key.")
    assert googlebooks._paused_until == 0.0


@pytest.mark.parametrize(
    ("status", "body", "key", "message"),
    [
        (
            400,
            "API key not valid. Please pass a valid API key.",
            "bad",
            "Google rejected the API key.",
        ),
        (403, "Books API has not been used in project", "k", "does not allow the Books API"),
        (429, "quota", "", "set an API key."),
        (429, "quota", "k", "daily quota may be used up."),
    ],
)
def test_google_probe_explains_failures(status: int, body: str, key: str, message: str) -> None:
    client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(status, text=body))
    )
    ok, text = googlebooks.probe(client, key)
    assert not ok and message in text


def test_the_admin_key_wins_over_the_environment(db: Session, settings: Settings) -> None:
    from folio.integrations import Integrations, google_books_key, save_integrations

    env = settings.model_copy(update={"google_books_api_key": "env-key"})
    assert google_books_key(db, env) == "env-key"
    save_integrations(db, Integrations(google_books_api_key="admin-key"))
    db.commit()
    assert google_books_key(db, env) == "admin-key"
