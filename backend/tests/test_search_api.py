"""Direction D §5.4: GET /search — top result, books, authors, series, type filter."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.models import Book, Chapter, Progress, Segment, User


def _book(db: Session, title: str, authors: list[str], **fields: Any) -> Book:
    book = Book(title=title, authors=authors, language="en", status="ready", **fields)
    db.add(book)
    db.commit()
    return book


def _finish(db: Session, user: User, book: Book) -> None:
    chapter = Chapter(book_id=book.id, idx=0, title="Ch 1", char_count=10)
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text="t", char_start=0, char_end=10)
    db.add(segment)
    db.flush()
    db.add(
        Progress(
            user_id=user.id,
            book_id=book.id,
            chapter_id=chapter.id,
            segment_id=segment.id,
            offset_s=0.0,
            percent=100.0,
            finished_at=datetime.now(UTC),
        )
    )
    db.commit()


def _user(db: Session) -> User:
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    return user


def _seed_wells(db: Session) -> Book:
    """Three Wells books (one finished) plus one unrelated book that mentions Wells."""
    _book(db, "The Time Machine", ["H. G. Wells"], series="Endpoints", created_at=datetime.now(UTC))
    _book(db, "The War of the Worlds", ["H. G. Wells"], created_at=datetime.now(UTC))
    finished = _book(
        db, "The Island of Doctor Moreau", ["H. G. Wells"], created_at=datetime.now(UTC)
    )
    _finish(db, _user(db), finished)
    _book(db, "Memoirs of a Wells Inn", ["Ada Hotel"], created_at=datetime.now(UTC))
    return finished


async def test_search_empty_query(auth_client: httpx.AsyncClient) -> None:
    for params in ({"q": ""}, {"q": "   "}, {}):
        body = (await auth_client.get("/api/v1/search", params=params)).json()
        assert body == {"top": None, "books": [], "authors": [], "series": []}


async def test_search_top_is_the_author(auth_client: httpx.AsyncClient, db: Session) -> None:
    _seed_wells(db)
    body = (await auth_client.get("/api/v1/search", params={"q": "wells"})).json()
    assert body["top"] == {
        "type": "author",
        "name": "H. G. Wells",
        "count": 3,
        "finished": 1,
    }
    assert {a["name"]: a["count"] for a in body["authors"]} == {"H. G. Wells": 3, "Ada Hotel": 1}
    assert len(body["books"]) == 4


async def test_search_top_is_a_book_when_no_author_matches(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db, "Dune", ["Frank Herbert"])
    body = (await auth_client.get("/api/v1/search", params={"q": "dune"})).json()
    assert body["top"]["type"] == "book"
    assert body["top"]["book"]["id"] == str(book.id)


async def test_search_series_grouping(auth_client: httpx.AsyncClient, db: Session) -> None:
    _book(db, "Wolf", ["A. Author"], series="The Saga")
    _book(db, "Bear", ["A. Author"], series="The Saga")
    body = (await auth_client.get("/api/v1/search", params={"q": "saga"})).json()
    assert body["series"] == [{"name": "The Saga", "count": 2}]


async def test_search_type_filter(auth_client: httpx.AsyncClient, db: Session) -> None:
    _seed_wells(db)
    books = (await auth_client.get("/api/v1/search", params={"q": "wells", "type": "books"})).json()
    assert books["authors"] == [] and books["series"] == [] and len(books["books"]) == 4
    assert books["top"]["type"] == "book"

    authors = (
        await auth_client.get("/api/v1/search", params={"q": "wells", "type": "authors"})
    ).json()
    assert authors["books"] == [] and authors["series"] == []
    assert authors["top"]["type"] == "author"

    series = (
        await auth_client.get("/api/v1/search", params={"q": "wells", "type": "series"})
    ).json()
    assert series["books"] == [] and series["authors"] == [] and series["top"] is None

    bad = await auth_client.get("/api/v1/search", params={"q": "wells", "type": "nonsense"})
    assert bad.status_code == 422


async def test_search_no_match(auth_client: httpx.AsyncClient, db: Session) -> None:
    _book(db, "Dune", ["Frank Herbert"])
    body = (await auth_client.get("/api/v1/search", params={"q": "asimov"})).json()
    assert body == {"top": None, "books": [], "authors": [], "series": []}


async def test_search_requires_session(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/v1/search", params={"q": "x"})).status_code == 401
