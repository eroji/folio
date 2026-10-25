"""Task P: /me/settings defaults, deep merge, validation; /me/continue empty state."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.models import Book, Chapter, Segment, User
from folio.routers.me import DEFAULT_SETTINGS

DEFAULTS = {
    "speed": 1.0,
    "voices": {},
    "skip_back": 15,
    "skip_forward": 30,
    "auto_next": True,
    "speak_titles": True,
}


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


async def test_settings_defaults(auth_client: httpx.AsyncClient) -> None:
    response = await auth_client.get("/api/v1/me/settings")
    assert response.status_code == 200, response.text
    assert response.json() == {"settings": DEFAULTS}
    assert DEFAULT_SETTINGS == DEFAULTS


async def test_settings_partial_merge(auth_client: httpx.AsyncClient, db: Session) -> None:
    response = await auth_client.put(
        "/api/v1/me/settings", json={"speed": 1.5}, headers=csrf(auth_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["settings"] == {**DEFAULTS, "speed": 1.5}

    response = await auth_client.put(
        "/api/v1/me/settings", json={"skip_back": 10, "auto_next": False}, headers=csrf(auth_client)
    )
    assert response.json()["settings"] == {
        **DEFAULTS,
        "speed": 1.5,
        "skip_back": 10,
        "auto_next": False,
    }
    fetched = await auth_client.get("/api/v1/me/settings")
    assert fetched.json()["settings"] == {
        **DEFAULTS,
        "speed": 1.5,
        "skip_back": 10,
        "auto_next": False,
    }

    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None and user.settings["speed"] == 1.5  # persisted, not just echoed


async def test_settings_voices_deep_merge(auth_client: httpx.AsyncClient) -> None:
    await auth_client.put(
        "/api/v1/me/settings", json={"voices": {"en": "ashley-en"}}, headers=csrf(auth_client)
    )
    response = await auth_client.put(
        "/api/v1/me/settings", json={"voices": {"de": "tobias-de"}}, headers=csrf(auth_client)
    )
    assert response.json()["settings"]["voices"] == {"en": "ashley-en", "de": "tobias-de"}


@pytest.mark.parametrize(
    "body",
    [
        {"speed": 1.1},  # not a 0.25 step
        {"speed": 0.5},
        {"speed": 2.75},
        {"skip_back": 3},
        {"skip_forward": 121},
        {"skip_back": 7.5},
        {"voices": {"en": ""}},  # empty voice id
        {"voices": {"en": None}},
        {"auto_next": "not-a-bool"},
        {"volume": 1},  # unknown key
    ],
)
async def test_settings_validation_failures(auth_client: httpx.AsyncClient, body: dict) -> None:
    response = await auth_client.put("/api/v1/me/settings", json=body, headers=csrf(auth_client))
    assert response.status_code == 422, body
    assert response.json()["error"]["code"] == "validation_failed"


@pytest.mark.parametrize("body", [{"speed": 0.75}, {"speed": 2.5}, {"skip_forward": 5}])
async def test_settings_accepts_boundary_values(auth_client: httpx.AsyncClient, body: dict) -> None:
    response = await auth_client.put("/api/v1/me/settings", json=body, headers=csrf(auth_client))
    assert response.status_code == 200, response.text


async def test_settings_are_per_user(client: httpx.AsyncClient) -> None:
    await client.post("/api/v1/test/login", json={"username": "alice", "role": "user"})
    await client.put("/api/v1/me/settings", json={"speed": 2.0}, headers=csrf(client))
    await client.post("/api/v1/test/login", json={"username": "bob", "role": "user"})
    assert (await client.get("/api/v1/me/settings")).json()["settings"]["speed"] == 1.0


async def test_continue_empty_and_shape(auth_client: httpx.AsyncClient, db: Session) -> None:
    assert (await auth_client.get("/api/v1/me/continue")).json() == {"items": []}

    book = Book(title="One", language="en", status="ready", total_chars=100)
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="Ch 0", char_count=100)
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text="s", char_start=0, char_end=100)
    db.add(segment)
    db.commit()

    response = await auth_client.put(
        f"/api/v1/books/{book.id}/progress",
        json={
            "chapter_id": str(chapter.id),
            "segment_id": str(segment.id),
            "offset_s": 1.0,
            "device_label": "Phone",
        },
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    items = (await auth_client.get("/api/v1/me/continue")).json()["items"]
    assert len(items) == 1
    assert items[0]["book"]["id"] == str(book.id)
    assert items[0]["progress"]["segment_id"] == str(segment.id)
    assert items[0]["progress"]["finished_at"] is None
