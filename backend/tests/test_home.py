"""Direction D §5.3: GET /me/home — continue and recent shelves + filters."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.models import Book, Chapter, Progress, Segment, User


def _listening_book(
    db: Session,
    user: User,
    title: str,
    *,
    chapters: int = 3,
    at: int = 1,
    percent: float = 50.0,
    est_duration_s: float = 7200.0,
    char_count: int = 150,
    language: str = "en",
    played_minutes_ago: float = 30.0,
    finished: bool = False,
    created_minutes_ago: float = 600.0,
    exclude: tuple[int, ...] = (),
    **book_fields: Any,
) -> Book:
    """Book with ``chapters`` chapters and the user's progress at chapter ``at``.

    ``exclude`` holds source indices (``idx``) of chapters hidden from playback.
    """
    now = datetime.now(UTC)
    book = Book(
        title=title,
        language=language,
        status="ready",
        total_chars=char_count * chapters,
        est_duration_s=est_duration_s,
        uploaded_by=user.id,
        created_at=now - timedelta(minutes=created_minutes_ago),
        **book_fields,
    )
    db.add(book)
    db.flush()
    rows: list[tuple[Chapter, Segment]] = []
    for i in range(chapters):
        chapter = Chapter(
            book_id=book.id,
            idx=i,
            title=f"Ch {i + 1}",
            char_count=char_count,
            excluded=i in exclude,
        )
        db.add(chapter)
        db.flush()
        segment = Segment(chapter_id=chapter.id, idx=0, text="t", char_start=0, char_end=char_count)
        db.add(segment)
        db.flush()
        rows.append((chapter, segment))
    chapter, segment = rows[at]
    db.add(
        Progress(
            user_id=user.id,
            book_id=book.id,
            chapter_id=chapter.id,
            segment_id=segment.id,
            offset_s=0.0,
            percent=percent,
            updated_at=now - timedelta(minutes=played_minutes_ago),
            finished_at=now if finished else None,
        )
    )
    db.commit()
    return book


def _fresh_book(db: Session, user: User, title: str, **fields: Any) -> Book:
    """A ready book the user never opened."""
    fields.setdefault("est_duration_s", 20.0)
    book = Book(
        title=title,
        language="en",
        status="ready",
        total_chars=300,
        uploaded_by=user.id,
        created_at=datetime.now(UTC),
        **fields,
    )
    db.add(book)
    db.commit()
    return book


def _user(db: Session) -> User:
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    return user


async def test_home_empty(auth_client: httpx.AsyncClient) -> None:
    body = (await auth_client.get("/api/v1/me/home")).json()
    assert body == {"continue": [], "recent": []}


async def test_home_shelves_and_shape(auth_client: httpx.AsyncClient, db: Session) -> None:
    user = _user(db)
    _listening_book(
        db, user, "Older", at=0, percent=10.0, played_minutes_ago=120.0, created_minutes_ago=600
    )
    _listening_book(
        db, user, "Newest", at=1, percent=50.0, played_minutes_ago=5.0, created_minutes_ago=580
    )
    _listening_book(
        db,
        user,
        "AtLastChapter",
        at=2,
        percent=90.0,
        played_minutes_ago=10.0,
        created_minutes_ago=590,
    )
    _fresh_book(db, user, "Fresh")

    body = (await auth_client.get("/api/v1/me/home")).json()
    assert set(body) == {"continue", "recent"}  # no Next chapters shelf

    assert [i["book"]["title"] for i in body["continue"]] == ["Newest", "AtLastChapter", "Older"]
    newest = body["continue"][0]
    assert (newest["chapter"]["idx"], newest["chapter"]["title"]) == (1, "Ch 2")
    assert newest["chapter"]["number"] == 2  # no exclusions: number == idx + 1
    assert newest["chapter"]["id"]
    assert newest["time_left_s"] == pytest.approx(3600.0)  # 7200 s at 50 %
    assert newest["progress"]["percent"] == 50.0

    assert [b["title"] for b in body["recent"]] == ["Fresh", "Newest", "AtLastChapter", "Older"]


async def test_home_continue_number_skips_excluded(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    """The chapter being played is numbered by its 1-based position among the
    included chapters, matching the book page (not the source ``idx + 1``)."""
    user = _user(db)
    # Included chapters are idx 1, 4 and 5, so the one being played shows as "2".
    _listening_book(db, user, "Gaps", chapters=6, at=4, exclude=(0, 2, 3))

    body = (await auth_client.get("/api/v1/me/home")).json()
    chapter = body["continue"][0]["chapter"]
    assert chapter["idx"] == 4
    assert chapter["number"] == 2
    assert chapter["title"] == "Ch 5"


async def test_home_status_filter(auth_client: httpx.AsyncClient, db: Session) -> None:
    user = _user(db)
    _listening_book(db, user, "Going")
    _listening_book(db, user, "Done", finished=True)
    _fresh_book(db, user, "Untouched")

    body = (await auth_client.get("/api/v1/me/home", params={"status": "in_progress"})).json()
    assert [b["title"] for b in body["recent"]] == ["Going"]
    assert [i["book"]["title"] for i in body["continue"]] == ["Going"]

    body = (await auth_client.get("/api/v1/me/home", params={"status": "finished"})).json()
    assert body["continue"] == []
    assert [b["title"] for b in body["recent"]] == ["Done"]

    body = (await auth_client.get("/api/v1/me/home", params={"status": "not_started"})).json()
    assert body["continue"] == []
    assert [b["title"] for b in body["recent"]] == ["Untouched"]

    bad = await auth_client.get("/api/v1/me/home", params={"status": "nonsense"})
    assert bad.status_code == 422


async def test_home_language_and_max_minutes(auth_client: httpx.AsyncClient, db: Session) -> None:
    user = _user(db)
    _listening_book(db, user, "English", language="en")
    _listening_book(db, user, "Japanese", language="ja", played_minutes_ago=1.0)
    _fresh_book(db, user, "Short", est_duration_s=1200.0)

    body = (await auth_client.get("/api/v1/me/home", params={"language": "ja"})).json()
    assert [i["book"]["title"] for i in body["continue"]] == ["Japanese"]
    assert [b["title"] for b in body["recent"]] == ["Japanese"]

    body = (await auth_client.get("/api/v1/me/home", params={"max_minutes": "30"})).json()
    assert [b["title"] for b in body["recent"]] == ["Short"]
    assert body["continue"] == []

    bad = await auth_client.get("/api/v1/me/home", params={"max_minutes": "0"})
    assert bad.status_code == 422


async def test_home_requires_session(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/v1/me/home")).status_code == 401
