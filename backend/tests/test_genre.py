"""Direction D §5.1: genre column, subject mapping, locking, grouped library list."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from sqlalchemy.orm import Session

from folio.config import GENRES
from folio.metadata import Candidate
from folio.metadata.service import apply_candidate, genre_from_subjects
from folio.models import Book


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _seed(db: Session, **fields: Any) -> Book:
    fields.setdefault("status", "ready")
    fields.setdefault("language", "en")
    book = Book(**fields)
    db.add(book)
    db.commit()
    return book


# --- subject → genre mapping --------------------------------------------------


@pytest.mark.parametrize(
    ("subjects", "want"),
    [
        (["Science fiction"], "Science fiction"),
        (["sci-fi"], "Science fiction"),
        (["Detective and mystery stories"], "Mystery & thriller"),
        (["Fantasy", "Science fiction"], "Fantasy"),  # first recognizable subject wins
        (["Cooking", "MYTHOLOGY"], "Myth & epic"),  # case-insensitive, skips noise
        (["Juvenile fiction"], "Children's"),
        (["Historical fiction"], "Historical fiction"),  # not "History" or "Literary fiction"
        (["non-fiction"], "Nonfiction"),
        (["Science"], "Science"),  # not "Science fiction"
        (["Biography & memoir"], "Biography & memoir"),  # genre names map to themselves
        (["Cooking", "Travel"], None),  # unmapped → NULL
        ([], None),
    ],
)
def test_genre_from_subjects(subjects: list[str], want: str | None) -> None:
    assert genre_from_subjects(subjects) == want


def test_genre_list_matches_the_handoff() -> None:
    assert GENRES == (
        "Classics",
        "Literary fiction",
        "Science fiction",
        "Fantasy",
        "Mystery & thriller",
        "Gothic & horror",
        "Romance",
        "Historical fiction",
        "Myth & epic",
        "Poetry",
        "Drama",
        "Biography & memoir",
        "History",
        "Science",
        "Philosophy",
        "Nonfiction",
        "Children's",
        "Japanese literature",
        "Korean literature",
        "Chinese literature",
    )


# --- auto-apply rules ----------------------------------------------------------


def test_auto_apply_maps_genre_from_subjects(db: Session, settings: Any) -> None:
    book = _seed(db, title="The Sea", authors=["A"])
    candidate = Candidate(
        id="1", source="openlibrary", title="The Sea", authors=["A"], tags=["Pirates", "Fantasy"]
    )
    applied = apply_candidate(db, book, candidate, ["tags", "genre"], settings)
    assert book.genre == "Fantasy"
    assert "genre" in applied


def test_auto_apply_unmapped_subjects_leave_genre_null(db: Session, settings: Any) -> None:
    book = _seed(db, title="Rocks", authors=["A"])
    candidate = Candidate(id="1", source="openlibrary", tags=["Geology"])
    applied = apply_candidate(db, book, candidate, ["genre"], settings)
    assert book.genre is None and applied == []


def test_auto_apply_never_overwrites_a_locked_genre(db: Session, settings: Any) -> None:
    book = _seed(db, title="The Sea", authors=["A"], genre="Poetry", locked_fields=["genre"])
    candidate = Candidate(id="1", source="openlibrary", tags=["Fantasy"])
    applied = apply_candidate(db, book, candidate, ["genre"], settings)
    assert book.genre == "Poetry" and applied == []


# --- PATCH /books/{id} ----------------------------------------------------------


async def test_patch_genre_locks_it(admin_client: httpx.AsyncClient, db: Session) -> None:
    book = _seed(db, title="A")
    response = await admin_client.patch(
        f"/api/v1/books/{book.id}", json={"genre": "Fantasy"}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["book"]["genre"] == "Fantasy"
    db.expire_all()
    book = db.get(Book, book.id)
    assert book is not None and "genre" in book.locked_fields


async def test_patch_genre_accepts_free_text_and_null(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _seed(db, title="A")
    response = await admin_client.patch(
        f"/api/v1/books/{book.id}", json={"genre": "Solarpunk"}, headers=csrf(admin_client)
    )
    assert response.json()["book"]["genre"] == "Solarpunk"
    response = await admin_client.patch(
        f"/api/v1/books/{book.id}", json={"genre": None}, headers=csrf(admin_client)
    )
    assert response.json()["book"]["genre"] is None


async def test_patch_genre_rejects_over_80_chars(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _seed(db, title="A")
    response = await admin_client.patch(
        f"/api/v1/books/{book.id}", json={"genre": "x" * 81}, headers=csrf(admin_client)
    )
    assert response.status_code == 422


# --- grouped listing -------------------------------------------------------------


async def test_list_group_genre_counts_order_and_cap(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    for i in range(13):
        _seed(db, title=f"F{i}", genre="Fantasy")
    _seed(db, title="M1", genre="Mystery & thriller")
    _seed(db, title="N1")  # no genre

    body = (await auth_client.get("/api/v1/books", params={"group": "genre"})).json()
    groups = body["groups"]
    assert [g["label"] for g in groups] == ["Fantasy", "Mystery & thriller", "No genre yet"]
    assert [g["key"] for g in groups] == ["Fantasy", "Mystery & thriller", None]
    assert [g["count"] for g in groups] == [13, 1, 1]
    assert len(groups[0]["books"]) == 12  # first N per group
    assert {b["title"] for b in groups[1]["books"]} == {"M1"}


@pytest.mark.parametrize(
    ("group", "expected"),
    [
        ("author", [("Ann", 2), ("Unknown author", 1)]),
        ("language", [("en", 2), ("ja", 1)]),
        ("status", [("processing", 1), ("ready", 2)]),
    ],
)
async def test_list_group_author_language_status(
    auth_client: httpx.AsyncClient, db: Session, group: str, expected: list[tuple[str, int]]
) -> None:
    _seed(db, title="A1", authors=["Ann"], language="en")
    _seed(db, title="A2", authors=["Ann", "Bob"], language="ja")
    _seed(db, title="A3", authors=[], language="en", status="processing")

    body = (await auth_client.get("/api/v1/books", params={"group": group})).json()
    assert [(g["label"], g["count"]) for g in body["groups"]] == expected
    assert all(len(g["books"]) <= 12 for g in body["groups"])


async def test_list_group_none_and_absent_stay_flat(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    _seed(db, title="A", genre="Fantasy")
    for params in ({}, {"group": "none"}):
        body = (await auth_client.get("/api/v1/books", params=params)).json()
        assert "groups" not in body and [b["title"] for b in body["items"]] == ["A"]


async def test_list_genre_filter(auth_client: httpx.AsyncClient, db: Session) -> None:
    _seed(db, title="F", genre="Fantasy")
    _seed(db, title="N")
    body = (await auth_client.get("/api/v1/books", params={"genre": "Fantasy"})).json()
    assert [b["title"] for b in body["items"]] == ["F"]
    body = (await auth_client.get("/api/v1/books", params={"genre": "none"})).json()
    assert [b["title"] for b in body["items"]] == ["N"]
    # the filter also applies inside groups
    body = (
        await auth_client.get("/api/v1/books", params={"genre": "Fantasy", "group": "genre"})
    ).json()
    assert [(g["label"], g["count"]) for g in body["groups"]] == [("Fantasy", 1)]
