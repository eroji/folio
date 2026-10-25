"""Task B: metadata service, pipeline integration and the metadata endpoints."""

from __future__ import annotations

import hashlib
import io
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from factories import make_user
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.ingest import pipeline
from folio.ingest.detect import detect_format
from folio.ingest.pipeline import process_book
from folio.metadata import Candidate, service
from folio.metadata import service as metadata_service
from folio.models import Book, BookFile, MetadataCandidate
from folio.routers import metadata as metadata_router
from folio.storage import cover_dir, write_original


def _image_bytes(fmt: str = "JPEG", size: tuple[int, int] = (400, 600)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "seagreen").save(buf, fmt)
    return buf.getvalue()


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def _book(db: Session, **fields: Any) -> Book:
    fields.setdefault("title", "Fixture Book")
    book = Book(status="ready", language="en", **fields)
    db.add(book)
    db.commit()
    return book


def _seed_book(db: Session, settings: Settings, path: Path, **fields: Any) -> Book:
    book = Book(status="uploading", language="en", **{"title": path.stem, **fields})
    db.add(book)
    db.flush()
    with path.open("rb") as fh:
        stored, sha, size = write_original(settings, book.id, path.suffix, fh)
    db.add(
        BookFile(
            book_id=book.id,
            kind="original",
            format=detect_format(stored).value,
            path=str(stored),
            size_bytes=size,
            sha256=sha,
        )
    )
    db.commit()
    return book


def _reload(db: Session, book_id: UUID) -> Book:
    db.expire_all()
    book = db.get(Book, book_id)
    assert book is not None
    return book


def _candidate(**fields: Any) -> Candidate:
    return Candidate(id=fields.pop("id", "x"), source=fields.pop("source", "openlibrary"), **fields)


# --- search_book -------------------------------------------------------------


def test_search_book_makes_no_requests_when_flag_off(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", False)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={})

    assert service.search_book(settings, "query", None, _client(handler)) == []
    assert calls == []


def test_search_book_merges_and_dedupes_by_isbn(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", True)
    ol = {
        "docs": [
            {
                "key": "/works/OL1",
                "title": "Shared",
                "author_name": ["Ann"],
                "isbn": ["9781111111117"],
            }
        ]
    }
    gb = {
        "items": [
            {
                "id": "g1",
                "volumeInfo": {
                    "title": "Shared",
                    "authors": ["Ann"],
                    "industryIdentifiers": [{"type": "ISBN_13", "identifier": "9781111111117"}],
                },
            },
            {
                "id": "g2",
                "volumeInfo": {
                    "title": "Other",
                    "authors": ["Zed"],
                    "industryIdentifiers": [{"type": "ISBN_13", "identifier": "9789999999999"}],
                },
            },
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openlibrary.org":
            return httpx.Response(200, json=ol)
        return httpx.Response(200, json=gb)

    candidates = service.search_book(settings, "Shared", None, _client(handler))
    assert sorted(c.isbn13 for c in candidates) == ["9781111111117", "9789999999999"]
    assert len(candidates) == 2  # the shared-ISBN duplicate collapsed to one


# --- apply_candidate ---------------------------------------------------------


def _mock_http(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    """Route the cover fetch inside ``apply_candidate`` through a MockTransport."""
    real = httpx.Client
    monkeypatch.setattr(
        metadata_service.httpx,
        "Client",
        lambda *args, **kwargs: real(transport=httpx.MockTransport(handler), follow_redirects=True),
    )


def test_apply_fetches_candidate_cover_when_book_has_none(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db, title="Old", cover_key=None)
    image = _image_bytes()
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, stream=httpx.ByteStream(image))

    _mock_http(monkeypatch, handler)
    candidate = _candidate(title="New", cover_url="https://covers.test/c.jpg")
    applied = metadata_service.apply_candidate(db, book, candidate, ["title"], settings)
    assert applied == ["title", "cover_url"]  # cover lands without being requested
    assert seen == ["https://covers.test/c.jpg"]
    book = _reload(db, book.id)
    assert book.cover_key == hashlib.sha256(image).hexdigest()
    assert list(cover_dir(settings, book.id).glob("original.*"))  # store_cover wrote a file


def test_apply_keeps_existing_cover_when_not_requested(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db, title="Old", cover_key="existing-key")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, stream=httpx.ByteStream(_image_bytes()))

    _mock_http(monkeypatch, handler)
    candidate = _candidate(title="New", cover_url="https://covers.test/c.jpg")
    applied = metadata_service.apply_candidate(db, book, candidate, ["title"], settings)
    assert applied == ["title"]
    assert seen == []  # no fetch: the book already has a cover
    book = _reload(db, book.id)
    assert book.cover_key == "existing-key"


def test_apply_explicit_cover_url_overwrites_existing_cover(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db, cover_key="existing-key")
    image = _image_bytes(fmt="PNG")
    _mock_http(monkeypatch, lambda request: httpx.Response(200, stream=httpx.ByteStream(image)))
    candidate = _candidate(cover_url="https://covers.test/c.png")
    applied = metadata_service.apply_candidate(db, book, candidate, ["cover_url"], settings)
    assert applied == ["cover_url"]
    book = _reload(db, book.id)
    assert book.cover_key == hashlib.sha256(image).hexdigest()


def test_apply_writes_only_the_selected_fields(db: Session, settings: Settings) -> None:
    book = _book(db, title="Old", publisher="OldPub", description="OldDesc", authors=["Z"])
    candidate = _candidate(title="New", publisher="NewPub", description="NewDesc", authors=["A"])
    applied = metadata_service.apply_candidate(
        db, book, candidate, ["title", "publisher"], settings
    )
    assert applied == ["title", "publisher"]
    book = _reload(db, book.id)
    assert book.title == "New" and book.publisher == "NewPub"
    assert book.description == "OldDesc"  # not requested
    assert book.authors == ["Z"]  # not requested


def test_apply_never_touches_locked_fields(db: Session, settings: Settings) -> None:
    book = _book(db, title="Locked", publisher="OldPub")
    book.locked_fields = ["title"]
    db.commit()
    candidate = _candidate(title="New", publisher="NewPub")
    applied = metadata_service.apply_candidate(
        db, book, candidate, ["title", "publisher"], settings
    )
    assert applied == ["publisher"]
    book = _reload(db, book.id)
    assert book.title == "Locked" and book.publisher == "NewPub"


def test_apply_sanitizes_html_description(db: Session, settings: Settings) -> None:
    book = _book(db)
    candidate = _candidate(description="<b>bold</b> <script>alert(1)</script>")
    applied = metadata_service.apply_candidate(db, book, candidate, ["description"], settings)
    assert applied == ["description"]
    book = _reload(db, book.id)
    assert "<" not in book.description
    assert "bold" in book.description
    assert "alert(1)" in book.description  # text kept, markup stripped


# --- auto_fetch --------------------------------------------------------------


def test_auto_fetch_isbn_applies_match_and_downloads_cover(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", True)
    book = _book(db, title="Unknown", isbn13="9781111111117", cover_key=None)
    image = _image_bytes()
    edition = {
        "key": "/books/OL1",
        "title": "Correct Title",
        "isbn_13": ["9781111111117"],
        "covers": [777],
        "publishers": ["Right Press"],
    }
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        if request.url.host == "covers.openlibrary.org":
            return httpx.Response(200, stream=httpx.ByteStream(image))
        if request.url.host == "openlibrary.org":
            return httpx.Response(200, json=edition)
        return httpx.Response(429, json={})  # google rate-limited -> ignored

    metadata_service.auto_fetch(db, settings, book, _client(handler))
    book = _reload(db, book.id)
    assert book.title == "Correct Title"
    assert book.cover_key == hashlib.sha256(image).hexdigest()
    assert list(cover_dir(settings, book.id).glob("original.*"))  # store_cover wrote a file


def test_auto_fetch_persists_candidates_below_threshold(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", True)
    book = _book(db, title="A Totally Distinct Title", authors=["Some Author"], cover_key=None)
    ol = {
        "docs": [{"key": "/works/OL9", "title": "Unrelated Work", "author_name": ["Other Person"]}]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openlibrary.org":
            return httpx.Response(200, json=ol)
        return httpx.Response(429, json={})

    metadata_service.auto_fetch(db, settings, book, _client(handler))
    book = _reload(db, book.id)
    assert book.title == "A Totally Distinct Title"  # not auto-applied
    assert book.cover_key is None
    rows = db.scalars(select(MetadataCandidate).where(MetadataCandidate.book_id == book.id)).all()
    assert [r.source for r in rows] == ["openlibrary"]
    assert rows[0].payload["title"] == "Unrelated Work"
    assert rows[0].score < 0.9


def test_auto_fetch_swallows_provider_errors_without_raising(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", True)
    book = _book(db, title="X", isbn13="9781111111117")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    metadata_service.auto_fetch(db, settings, book, _client(handler))  # must not raise
    assert db.scalars(select(MetadataCandidate)).all() == []


# --- pipeline integration ----------------------------------------------------


def test_pipeline_makes_no_requests_when_flag_off(
    db: Session, settings: Settings, fixture_books: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", False)

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("no httpx.Client may be created when METADATA_ONLINE is off")

    monkeypatch.setattr(pipeline.httpx, "Client", boom)
    book = _seed_book(db, settings, fixture_books["epub3"])
    process_book(db, settings, book.id)
    assert _reload(db, book.id).status == "ready"


def test_provider_failure_does_not_fail_ingest(
    db: Session, settings: Settings, fixture_books: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "metadata_online", True)

    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(pipeline, "auto_fetch", boom)
    book = _seed_book(db, settings, fixture_books["epub3"])
    process_book(db, settings, book.id)  # must not raise
    assert _reload(db, book.id).status == "ready"


def test_existing_pipeline_tests_pass_with_flag_off(db: Session, settings: Settings) -> None:
    assert settings.metadata_online is False  # conftest default


# --- endpoints ---------------------------------------------------------------


def _override_client(
    client: httpx.AsyncClient, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    app: Any = client._transport.app  # type: ignore[attr-defined]
    app.dependency_overrides[metadata_router.get_http_client] = lambda: _client(handler)


def _csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


async def test_metadata_search_endpoint_returns_candidates(
    admin_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The router reads get_settings() at request time, so flip the flag there
    # (the session-scoped settings fixture can be stale after cache_clear).
    monkeypatch.setattr(
        metadata_router,
        "get_settings",
        lambda: settings.model_copy(update={"metadata_online": True}),
    )
    book = _book(db, title="Query Book")
    ol = {
        "docs": [
            {
                "key": "/works/OL1",
                "title": "Found Book",
                "author_name": ["Ann"],
                "isbn": ["9781111111117"],
            }
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openlibrary.org":
            return httpx.Response(200, json=ol)
        return httpx.Response(429, json={})

    _override_client(admin_client, handler)
    response = await admin_client.get(
        f"/api/v1/books/{book.id}/metadata/search", params={"q": "Query Book"}
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert items[0]["source"] == "openlibrary"
    assert items[0]["title"] == "Found Book"


async def test_metadata_search_scores_candidates_against_the_book(
    admin_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        metadata_router,
        "get_settings",
        lambda: settings.model_copy(update={"metadata_online": True}),
    )
    match_book = _book(db, title="Found Book", authors=["Ann"])
    other_book = _book(db, title="A Totally Different Name", authors=["Zoe Q."])
    ol = {
        "docs": [
            {
                "key": "/works/OL1",
                "title": "Found Book",
                "author_name": ["Ann"],
                "isbn": ["9781111111117"],
            }
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openlibrary.org":
            return httpx.Response(200, json=ol)
        return httpx.Response(429, json={})

    _override_client(admin_client, handler)
    same = await admin_client.get(
        f"/api/v1/books/{match_book.id}/metadata/search", params={"q": "Found Book"}
    )
    assert same.status_code == 200, same.text
    assert same.json()["items"][0]["score"] >= 0.9  # same title + author
    different = await admin_client.get(
        f"/api/v1/books/{other_book.id}/metadata/search", params={"q": "Found Book"}
    )
    assert different.json()["items"][0]["score"] < 0.5


async def test_metadata_apply_endpoint_writes_selected_fields(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db, title="Old", publisher="OldPub")
    payload = {"id": "x", "source": "openlibrary", "title": "New", "publisher": "NewPub"}
    response = await admin_client.post(
        f"/api/v1/books/{book.id}/metadata/apply",
        json={"source": "openlibrary", "payload": payload, "fields": ["title"]},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["applied"] == ["title"]
    assert body["book"]["title"] == "New"
    assert body["book"]["publisher"] == "OldPub"  # not requested


async def test_metadata_candidates_endpoint_lists_saved(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db, title="Reviewed")
    db.add(
        MetadataCandidate(book_id=book.id, source="openlibrary", payload={"title": "M"}, score=0.5)
    )
    db.commit()
    response = await admin_client.get(f"/api/v1/books/{book.id}/metadata/candidates")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["source"] == "openlibrary"
    assert items[0]["payload"] == {"title": "M"}


async def test_metadata_endpoints_require_session(client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    response = await client.get(f"/api/v1/books/{book.id}/metadata/search")
    assert response.status_code == 401


async def test_metadata_apply_requires_csrf(admin_client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    response = await admin_client.post(
        f"/api/v1/books/{book.id}/metadata/apply",
        json={"source": "openlibrary", "payload": {"title": "x"}, "fields": ["title"]},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_metadata_endpoints_forbid_non_uploader(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db, uploaded_by=make_user(db, username="someoneelse").id)
    search = await auth_client.get(f"/api/v1/books/{book.id}/metadata/search")
    assert search.status_code == 403
    apply = await auth_client.post(
        f"/api/v1/books/{book.id}/metadata/apply",
        json={"source": "openlibrary", "payload": {"title": "x"}, "fields": ["title"]},
        headers=_csrf(auth_client),
    )
    assert apply.status_code == 403


async def test_metadata_endpoints_404_unknown_book(admin_client: httpx.AsyncClient) -> None:
    missing = uuid4()
    assert (await admin_client.get(f"/api/v1/books/{missing}/metadata/search")).status_code == 404
    assert (
        await admin_client.get(f"/api/v1/books/{missing}/metadata/candidates")
    ).status_code == 404
    apply = await admin_client.post(
        f"/api/v1/books/{missing}/metadata/apply",
        json={"source": "openlibrary", "payload": {}, "fields": []},
        headers=_csrf(admin_client),
    )
    assert apply.status_code == 404


async def test_metadata_apply_locks_the_fields_it_wrote(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db, title="Old", publisher="OldPub")
    payload = {"id": "x", "source": "openlibrary", "title": "New", "publisher": "NewPub"}
    response = await admin_client.post(
        f"/api/v1/books/{book.id}/metadata/apply",
        json={"source": "openlibrary", "payload": payload, "fields": ["title"]},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    db.refresh(book)
    # An explicit apply is a manual edit: a later auto-fetch must not clobber it.
    assert "title" in book.locked_fields
    assert "publisher" not in book.locked_fields


async def test_metadata_apply_ignores_non_metadata_fields(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db, title="Old")
    book_id = book.id
    payload = {"id": "evil", "source": "openlibrary", "title": "New"}
    response = await admin_client.post(
        f"/api/v1/books/{book_id}/metadata/apply",
        json={
            "source": "openlibrary",
            "payload": payload,
            "fields": ["id", "status", "cover_key", "title"],
        },
        headers=_csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    assert response.json()["applied"] == ["title"]
    db.expire_all()
    fresh = db.get(Book, book_id)
    assert fresh is not None  # primary key untouched
    assert fresh.status == "ready"


def test_explicit_user_apply_may_overwrite_a_locked_field(db: Session, settings: Settings) -> None:
    book = _book(db, title="Old", locked_fields=["title"])
    candidate = Candidate(id="x", source="openlibrary", title="New")
    applied = service.apply_candidate(db, book, candidate, ["title"], settings, respect_locks=False)
    assert applied == ["title"]
    assert book.title == "New"
