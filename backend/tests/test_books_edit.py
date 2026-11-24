"""Task C: editable metadata via PATCH /books/{id} and locked_fields."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.db import SessionLocal
from folio.models import Book, Chapter, Segment, SegmentAudio

ALL_FIELDS: dict[str, Any] = {
    "title": "Edited Title",
    "subtitle": "A Subtitle",
    "authors": ["Alice", "Bob"],
    "series": "The Series",
    "series_index": 3.5,
    "description": "Plain text.",
    "publisher": "Folio Press",
    "published_date": "2024",
    "language": "zh-TW",
    "isbn10": "0-306-40615-2",  # hyphens are stripped, checksum validated
    "isbn13": "9780306406157",
    "tags": ["classic", "audio"],
    "narrator_voice": "serena",
}


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


async def upload(client: httpx.AsyncClient, path: Path) -> UUID:
    with path.open("rb") as fh:
        response = await client.post(
            "/api/v1/books",
            files={"files": (path.name, fh, "application/octet-stream")},
            headers=csrf(client),
        )
    assert response.status_code == 200, response.text
    return UUID(response.json()[0]["book_id"])


def run_worker(settings: Settings) -> None:
    """Process exactly one queued job through the real handler."""
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()


def reload_book(db: Session, book_id: UUID) -> Book:
    db.expire_all()
    book = db.get(Book, book_id)
    assert book is not None
    return book


async def test_patch_every_field_roundtrips_through_get(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    response = await auth_client.patch(url, json=ALL_FIELDS, headers=csrf(auth_client))
    assert response.status_code == 200, response.text
    assert response.json()["book"]["title"] == "Edited Title"
    body = (await auth_client.get(url)).json()["book"]
    assert body["title"] == "Edited Title"
    assert body["subtitle"] == "A Subtitle"
    assert body["authors"] == ["Alice", "Bob"]
    assert body["series"] == "The Series"
    assert body["series_index"] == 3.5
    assert body["description"] == "Plain text."
    assert body["publisher"] == "Folio Press"
    assert body["published_date"] == "2024"
    assert body["language"] == "zh-TW"
    assert body["isbn10"] == "0306406152"
    assert body["isbn13"] == "9780306406157"
    assert body["tags"] == ["classic", "audio"]
    assert body["narrator_voice"] == "serena"
    assert set(body["locked_fields"]) == set(ALL_FIELDS)  # exposed for the lock icons
    assert set(reload_book(db, book_id).locked_fields) == set(ALL_FIELDS)


async def test_changing_the_narrator_cancels_the_old_voices_pending_audio(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    """Switching the narrator stopped the old voice's queued chapter: the
    engine kept synthesizing the voice the listener had just left."""
    book = Book(title="Voice Book", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=10)
    db.add(chapter)
    db.flush()
    first = Segment(chapter_id=chapter.id, idx=0, text="Hello there.", char_start=0, char_end=12)
    second = Segment(chapter_id=chapter.id, idx=1, text="And again.", char_start=12, char_end=22)
    db.add_all([first, second])
    db.flush()
    db.add_all(
        [
            SegmentAudio(segment_id=first.id, voice="bennett", status="queued"),
            SegmentAudio(segment_id=second.id, voice="bennett", status="ready"),
            SegmentAudio(segment_id=first.id, voice="sarah", status="queued"),
        ]
    )
    db.commit()

    response = await admin_client.patch(
        f"/api/v1/books/{book.id}",
        json={"narrator_voice": "sarah"},
        headers=csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    rows = {(row.voice, row.segment_id): row.status for row in db.scalars(select(SegmentAudio))}
    assert rows == {
        ("bennett", second.id): "ready",
        ("sarah", first.id): "queued",
    }


async def test_partial_patch_leaves_other_fields_untouched(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    await auth_client.patch(url, json=ALL_FIELDS, headers=csrf(auth_client))
    response = await auth_client.patch(
        url, json={"publisher": "Other Press"}, headers=csrf(auth_client)
    )
    assert response.status_code == 200, response.text
    body = response.json()["book"]
    assert body["publisher"] == "Other Press"
    assert body["title"] == "Edited Title"
    assert body["isbn13"] == "9780306406157"
    assert body["tags"] == ["classic", "audio"]
    # publisher was already locked by the first PATCH: no duplicate entry
    locked = reload_book(db, book_id).locked_fields
    assert set(locked) == set(ALL_FIELDS) and len(locked) == len(ALL_FIELDS)


async def test_get_cleans_legacy_control_characters_in_descriptions(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    # Simulate a row written before clean_description existed.
    book = reload_book(db, book_id)
    book.description = 'Galileo."\x9d Next\xa0line'
    db.commit()
    body = (await auth_client.get(f"/api/v1/books/{book_id}")).json()["book"]
    assert body["description"] == 'Galileo." Next line'


async def test_get_decodes_entities_left_in_legacy_descriptions(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    # Rows written before entities were decoded on write still hold them.
    book = reload_book(db, book_id)
    book.description = "&ldquo;Galileo&rdquo; &mdash; Tom &amp; Jerry"
    db.commit()
    body = (await auth_client.get(f"/api/v1/books/{book_id}")).json()["book"]
    assert body["description"] == "\u201cGalileo\u201d \u2014 Tom & Jerry"


async def test_patch_description_decodes_entities(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    response = await auth_client.patch(
        f"/api/v1/books/{book_id}",
        json={"description": "<p>&ldquo;Q&rdquo; a < b</p>"},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    assert reload_book(db, book_id).description == "\u201cQ\u201d a < b"


async def test_metadata_fields_are_written_without_being_locked(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    # Genre starts locked (a prior manual edit).
    await auth_client.patch(url, json={"genre": "Fantasy"}, headers=csrf(auth_client))
    response = await auth_client.patch(
        url,
        json={
            "title": "Typed Title",
            "genre": "Mystery",
            "metadata_fields": ["genre"],
        },
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    body = response.json()["book"]
    assert body["genre"] == "Mystery"
    assert body["title"] == "Typed Title"
    # The typed field is locked, the metadata-sourced one is not (and its old lock is gone).
    assert body["locked_fields"] == ["title"]
    assert reload_book(db, book_id).locked_fields == ["title"]


async def test_metadata_fields_must_name_real_fields(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    response = await auth_client.patch(
        f"/api/v1/books/{book_id}",
        json={"title": "X", "metadata_fields": ["not_a_field"]},
        headers=csrf(auth_client),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    assert reload_book(db, book_id).title != "X"


async def test_invalid_isbn_checksums_are_rejected(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    for field, value in [
        ("isbn10", "0306406153"),  # checksum off by one
        ("isbn13", "9780306406158"),
        ("isbn10", "not-an-isbn"),
        ("isbn13", "978-0-306-40615"),  # 12 digits after stripping
    ]:
        response = await auth_client.patch(url, json={field: value}, headers=csrf(auth_client))
        assert response.status_code == 422, (field, value, response.text)
        assert response.json()["error"]["code"] == "validation_failed"
    assert reload_book(db, book_id).locked_fields == []  # nothing written


async def test_null_clears_optional_fields_but_not_title(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    await auth_client.patch(
        url, json={"subtitle": "Temp", "description": "d"}, headers=csrf(auth_client)
    )
    response = await auth_client.patch(url, json={"subtitle": None}, headers=csrf(auth_client))
    assert response.status_code == 200, response.text
    assert response.json()["book"]["subtitle"] is None
    assert "subtitle" in reload_book(db, book_id).locked_fields
    for bad in [{"title": None}, {"title": "   "}]:
        response = await auth_client.patch(url, json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad
    # NOT NULL columns cannot be cleared
    for bad in [{"language": None}, {"authors": None}, {"tags": None}]:
        response = await auth_client.patch(url, json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad


async def test_locked_fields_accumulate_and_latest_value_wins(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    assert (
        await auth_client.patch(url, json={"title": "First"}, headers=csrf(auth_client))
    ).status_code == 200
    assert (
        await auth_client.patch(
            url, json={"title": "Second", "subtitle": "Sub"}, headers=csrf(auth_client)
        )
    ).status_code == 200
    book = reload_book(db, book_id)
    assert book.title == "Second" and book.subtitle == "Sub"
    assert set(book.locked_fields) == {"title", "subtitle"} and len(book.locked_fields) == 2
    assert book.locked_fields[0] == "title"  # existing entries preserved


async def test_reprocess_after_edit_preserves_edited_values(
    auth_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    fixture_books: dict[str, Path],
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    run_worker(settings)
    assert reload_book(db, book_id).status == "ready"
    url = f"/api/v1/books/{book_id}"
    response = await auth_client.patch(
        url,
        json={"title": "Edited Title", "authors": ["Edited Author"]},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    assert (
        await auth_client.post(f"{url}/reprocess", headers=csrf(auth_client))
    ).status_code == 200
    run_worker(settings)
    book = reload_book(db, book_id)
    assert book.status == "ready"
    assert book.title == "Edited Title"
    assert book.authors == ["Edited Author"]


async def test_permission_csrf_and_unknown_book(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    # non-uploader non-admin
    await auth_client.post("/api/v1/test/login", json={"username": "someoneelse", "role": "user"})
    denied = await auth_client.patch(url, json={"title": "Nope"}, headers=csrf(auth_client))
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"
    # uploader may edit but only with CSRF
    await auth_client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    missing = await auth_client.patch(url, json={"title": "Nope"})
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "csrf_failed"
    # an admin edits someone else's book
    await auth_client.post("/api/v1/test/login", json={"username": "testadmin", "role": "admin"})
    ok = await auth_client.patch(url, json={"title": "Admin Edit"}, headers=csrf(auth_client))
    assert ok.status_code == 200 and ok.json()["book"]["title"] == "Admin Edit"
    unknown = await auth_client.patch(
        f"/api/v1/books/{UUID(int=0)}", json={"title": "x"}, headers=csrf(auth_client)
    )
    assert unknown.status_code == 404


async def test_authors_and_tags_trimmed_deduped_order_preserved(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    response = await auth_client.patch(
        url,
        json={"authors": [" Ann ", "Ann", "Bob"], "tags": ["x", "y ", "x"]},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    body = response.json()["book"]
    assert body["authors"] == ["Ann", "Bob"]
    assert body["tags"] == ["x", "y"]
    for bad in [{"authors": ["ok", ""]}, {"tags": ["  "]}, {"authors": "not-a-list"}]:
        response = await auth_client.patch(url, json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad


async def test_description_html_is_stripped(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    response = await auth_client.patch(
        url,
        json={"description": "<b>bold</b> & <script>alert(1)</script>text"},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    assert (
        response.json()["book"]["description"] == "bold & alert(1)text"
    )  # plain text: no escaped &amp;


async def test_description_control_characters_are_stripped(
    auth_client: httpx.AsyncClient, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    response = await auth_client.patch(
        f"/api/v1/books/{book_id}",
        json={"description": "a\xa0b\x9dc\u200bd\nnext"},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    assert response.json()["book"]["description"] == "a bcd\nnext"


async def test_unlock_removes_the_field_and_is_idempotent(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    await auth_client.patch(url, json={"title": "T", "subtitle": "S"}, headers=csrf(auth_client))
    response = await auth_client.post(
        f"{url}/unlock", json={"field": "title"}, headers=csrf(auth_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["book"]["locked_fields"] == ["subtitle"]
    again = await auth_client.post(
        f"{url}/unlock", json={"field": "title"}, headers=csrf(auth_client)
    )
    assert again.status_code == 200, again.text
    assert reload_book(db, book_id).locked_fields == ["subtitle"]


async def test_unlock_validates_field_permissions_and_csrf(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    for bad in [{"field": "cover"}, {"field": "locked_fields"}, {"field": ""}]:
        response = await auth_client.post(f"{url}/unlock", json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad
        assert response.json()["error"]["code"] == "validation_failed"
    missing = await auth_client.post(f"{url}/unlock", json={"field": "title"})
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "csrf_failed"
    await auth_client.post("/api/v1/test/login", json={"username": "someoneelse", "role": "user"})
    denied = await auth_client.post(
        f"{url}/unlock", json={"field": "title"}, headers=csrf(auth_client)
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"
    unknown = await auth_client.post(
        f"/api/v1/books/{UUID(int=0)}/unlock", json={"field": "title"}, headers=csrf(auth_client)
    )
    assert unknown.status_code == 404
    assert reload_book(db, book_id).locked_fields == []  # nothing was ever written


async def test_language_series_index_and_length_validation(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    book_id = await upload(auth_client, fixture_books["epub3"])
    url = f"/api/v1/books/{book_id}"
    for bad in [
        {"language": "english"},
        {"language": "e"},
        {"language": "en-"},
        {"series_index": -1},
        {"title": "x" * 513},
        {"publisher": "p" * 256},
        {"published_date": "2" * 33},
        {"narrator_voice": "v" * 65},
    ]:
        response = await auth_client.patch(url, json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad
    for good in [{"language": "en-US"}, {"language": "pt-BR"}, {"series_index": 0}]:
        response = await auth_client.patch(url, json=good, headers=csrf(auth_client))
        assert response.status_code == 200, good
    # JSON literals like 1e400 parse to inf, which is not a finite number.
    response = await auth_client.patch(
        url,
        content=b'{"series_index": 1e400}',
        headers={"Content-Type": "application/json", **csrf(auth_client)},
    )
    assert response.status_code == 422, response.text
