"""Task P: progress upsert, percent math, cross-device flag, finished, migration 0005."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import httpx
import psycopg
import pytest
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.models import Book, Chapter, Progress, Segment

sys_path = Path(__file__).resolve().parents[1]


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _book(
    db: Session, chapters: int = 3, size: int = 100, total: int | None = None
) -> tuple[Book, list[Chapter], list[Segment]]:
    """Chapters of ``size`` chars; each has segments at char_start 0, 50 and 85."""
    book = Book(
        title="Progress Book",
        language="en",
        status="ready",
        total_chars=chapters * size if total is None else total,
    )
    db.add(book)
    db.flush()
    chapter_rows: list[Chapter] = []
    segment_rows: list[Segment] = []
    for idx in range(chapters):
        chapter = Chapter(book_id=book.id, idx=idx, title=f"Ch {idx}", char_count=size)
        db.add(chapter)
        db.flush()
        chapter_rows.append(chapter)
        for si, start in enumerate((0, 50, 85)):
            segment = Segment(
                chapter_id=chapter.id, idx=si, text=f"s{si}", char_start=start, char_end=start + 30
            )
            db.add(segment)
            segment_rows.append(segment)
    db.commit()
    return book, chapter_rows, segment_rows


def _body(chapter: Chapter, segment: Segment, label: str = "Phone", offset_s: float = 0.0) -> dict:
    return {
        "chapter_id": str(chapter.id),
        "segment_id": str(segment.id),
        "offset_s": offset_s,
        "device_label": label,
    }


def _segments_of(chapter: Chapter, segments: list[Segment]) -> list[Segment]:
    return [s for s in segments if s.chapter_id == chapter.id]


async def test_put_creates_then_upserts_one_row(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, chapters, segments = _book(db)
    url = f"/api/v1/books/{book.id}/progress"
    first = _segments_of(chapters[0], segments)[0]
    response = await auth_client.put(url, json=_body(chapters[0], first), headers=csrf(auth_client))
    assert response.status_code == 200, response.text
    progress = response.json()["progress"]
    assert progress["chapter_id"] == str(chapters[0].id)
    assert progress["segment_id"] == str(first.id)
    assert progress["offset_s"] == 0.0
    assert progress["device_label"] == "Phone"
    assert progress["finished_at"] is None
    assert response.json()["ahead_of_other_device"] is False

    second = _segments_of(chapters[1], segments)[1]
    again = await auth_client.put(
        url, json=_body(chapters[1], second, label="Phone", offset_s=4.5), headers=csrf(auth_client)
    )
    assert again.status_code == 200, again.text
    assert again.json()["progress"]["segment_id"] == str(second.id)
    assert again.json()["progress"]["offset_s"] == pytest.approx(4.5)
    rows = db.scalars(select(Progress)).all()
    assert len(rows) == 1  # upsert, never a second row for one user+book
    assert rows[0].book_id == book.id

    fetched = await auth_client.get(url)
    assert fetched.json()["progress"]["segment_id"] == str(second.id)


async def test_progress_is_per_user(client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    seg = _segments_of(chapters[0], segments)[0]
    url = f"/api/v1/books/{book.id}/progress"
    await client.post("/api/v1/test/login", json={"username": "alice", "role": "user"})
    saved = await client.put(url, json=_body(chapters[0], seg), headers=csrf(client))
    assert saved.status_code == 200

    await client.post("/api/v1/test/login", json={"username": "bob", "role": "user"})
    assert (await client.get(url)).json() == {"progress": None}  # bob sees nothing
    other = _segments_of(chapters[2], segments)[2]
    put = await client.put(url, json=_body(chapters[2], other), headers=csrf(client))
    assert put.status_code == 200

    await client.post("/api/v1/test/login", json={"username": "alice", "role": "user"})
    alice = (await client.get(url)).json()["progress"]
    assert alice["segment_id"] == str(seg.id)  # bob's write did not touch alice's row
    assert len(db.scalars(select(Progress)).all()) == 2


@pytest.mark.parametrize(
    ("chapter_idx", "seg_idx", "expected"),
    [(0, 0, 0.0), (1, 1, 50.0), (2, 2, 95.0)],
)
async def test_percent_math(
    auth_client: httpx.AsyncClient, db: Session, chapter_idx: int, seg_idx: int, expected: float
) -> None:
    book, chapters, segments = _book(db, chapters=3, size=100, total=300)
    segment = _segments_of(chapters[chapter_idx], segments)[seg_idx]
    response = await auth_client.put(
        f"/api/v1/books/{book.id}/progress",
        json=_body(chapters[chapter_idx], segment),
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    assert response.json()["progress"]["percent"] == pytest.approx(expected, abs=0.01)


async def test_percent_zero_when_no_chars(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db, chapters=3, total=0)
    response = await auth_client.put(
        f"/api/v1/books/{book.id}/progress",
        json=_body(chapters[2], _segments_of(chapters[2], segments)[2]),
        headers=csrf(auth_client),
    )
    assert response.json()["progress"]["percent"] == 0.0


async def test_percent_clamped_to_100(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db, chapters=3, size=100, total=100)
    response = await auth_client.put(
        f"/api/v1/books/{book.id}/progress",
        json=_body(chapters[1], _segments_of(chapters[1], segments)[1]),
        headers=csrf(auth_client),
    )
    assert response.json()["progress"]["percent"] == pytest.approx(100.0)


async def test_ahead_of_other_device(auth_client: httpx.AsyncClient, db: Session) -> None:
    # 12 chapters x 100 chars; 60 s at the default 15 chars/s is 900 chars.
    book, chapters, segments = _book(db, chapters=12)
    url = f"/api/v1/books/{book.id}/progress"
    start = _segments_of(chapters[0], segments)[0]
    far = _segments_of(chapters[9], segments)[1]  # char 950 -> 63.3 s
    near = _segments_of(chapters[8], segments)[2]  # char 885 -> 59.0 s

    async def put(chapter: Chapter, segment: Segment, label: str) -> bool:
        response = await auth_client.put(
            url, json=_body(chapter, segment, label), headers=csrf(auth_client)
        )
        assert response.status_code == 200, response.text
        return response.json()["ahead_of_other_device"]

    assert await put(chapters[8], near, "Phone") is False  # no previous row
    assert await put(chapters[0], start, "Laptop") is False  # 59 s ahead: not enough
    assert await put(chapters[9], far, "Phone") is False  # incoming is the ahead one
    assert await put(chapters[0], start, "Laptop") is True  # 63.3 s ahead, other device
    assert await put(chapters[0], start, "Laptop") is False  # same device label


async def test_finished_toggle_and_delete(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    seg = _segments_of(chapters[0], segments)[0]
    url = f"/api/v1/books/{book.id}/progress"
    await auth_client.put(url, json=_body(chapters[0], seg), headers=csrf(auth_client))

    response = await auth_client.put(
        f"{url}/finished", json={"finished": True}, headers=csrf(auth_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["progress"]["finished_at"] is not None
    assert (await auth_client.get(url)).json()["progress"]["finished_at"] is not None

    response = await auth_client.put(
        f"{url}/finished", json={"finished": False}, headers=csrf(auth_client)
    )
    assert response.json()["progress"]["finished_at"] is None

    deleted = await auth_client.delete(url, headers=csrf(auth_client))
    assert deleted.status_code == 204
    assert (await auth_client.get(url)).json() == {"progress": None}
    assert (await auth_client.delete(url, headers=csrf(auth_client))).status_code == 204


async def test_continue_lists_unfinished_newest_first(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book_a, chapters_a, segments_a = _book(db)
    book_b, chapters_b, segments_b = _book(db)
    for book, chapters, segments in (
        (book_a, chapters_a, segments_a),
        (book_b, chapters_b, segments_b),
    ):
        response = await auth_client.put(
            f"/api/v1/books/{book.id}/progress",
            json=_body(chapters[0], _segments_of(chapters[0], segments)[0]),
            headers=csrf(auth_client),
        )
        assert response.status_code == 200, response.text
    # Touch A again so it is the most recent.
    await auth_client.put(
        f"/api/v1/books/{book_a.id}/progress",
        json=_body(chapters_a[0], _segments_of(chapters_a[0], segments_a)[1]),
        headers=csrf(auth_client),
    )

    items = (await auth_client.get("/api/v1/me/continue")).json()["items"]
    assert [item["book"]["id"] for item in items] == [str(book_a.id), str(book_b.id)]
    assert items[0]["progress"]["segment_id"] == str(_segments_of(chapters_a[0], segments_a)[1].id)
    assert (await auth_client.get("/api/v1/me/continue?limit=1")).json()["items"] == items[:1]

    await auth_client.put(
        f"/api/v1/books/{book_a.id}/progress/finished",
        json={"finished": True},
        headers=csrf(auth_client),
    )
    items = (await auth_client.get("/api/v1/me/continue")).json()["items"]
    assert [item["book"]["id"] for item in items] == [str(book_b.id)]


async def test_requires_session_and_csrf(client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    seg = _segments_of(chapters[0], segments)[0]
    url = f"/api/v1/books/{book.id}/progress"
    assert (await client.get(url)).status_code == 401
    assert (await client.put(url, json=_body(chapters[0], seg))).status_code == 401
    assert (await client.delete(url)).status_code == 401
    assert (await client.get("/api/v1/me/settings")).status_code == 401

    await client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    response = await client.put(url, json=_body(chapters[0], seg))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"
    response = await client.delete(url)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"
    response = await client.put(f"{url}/finished", json={"finished": True})
    assert response.status_code == 403
    response = await client.put("/api/v1/me/settings", json={"speed": 1.5})
    assert response.status_code == 403


async def test_foreign_chapter_or_segment_rejected(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, chapters, segments = _book(db)
    _other, other_chapters, other_segments = _book(db)
    url = f"/api/v1/books/{book.id}/progress"

    response = await auth_client.put(
        url,
        json=_body(other_chapters[0], _segments_of(chapters[0], segments)[0]),
        headers=csrf(auth_client),
    )
    assert response.status_code == 404
    response = await auth_client.put(
        url,
        json=_body(chapters[0], _segments_of(other_chapters[0], other_segments)[0]),
        headers=csrf(auth_client),
    )
    assert response.status_code == 404
    response = await auth_client.put(
        f"/api/v1/books/{other_chapters[0].id}/progress",  # chapter id as book id
        json=_body(chapters[0], _segments_of(chapters[0], segments)[0]),
        headers=csrf(auth_client),
    )
    assert response.status_code == 404
    response = await auth_client.put(
        url,
        json=_body(chapters[0], _segments_of(chapters[1], segments)[0]),  # wrong chapter
        headers=csrf(auth_client),
    )
    assert response.status_code == 404


async def test_put_rejects_bad_bodies(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    seg = _segments_of(chapters[0], segments)[0]
    url = f"/api/v1/books/{book.id}/progress"
    bad = [
        {**_body(chapters[0], seg), "offset_s": -1},
        {**_body(chapters[0], seg), "device_label": "x" * 65},
        {**_body(chapters[0], seg), "chapter_id": "not-a-uuid"},
    ]
    for body in bad:
        response = await auth_client.put(url, json=body, headers=csrf(auth_client))
        assert response.status_code == 422, body


async def test_book_detail_includes_caller_progress(client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    seg = _segments_of(chapters[1], segments)[1]
    await client.post("/api/v1/test/login", json={"username": "alice", "role": "user"})
    await client.put(
        f"/api/v1/books/{book.id}/progress", json=_body(chapters[1], seg), headers=csrf(client)
    )
    detail = (await client.get(f"/api/v1/books/{book.id}")).json()
    assert detail["progress"]["chapter_id"] == str(chapters[1].id)
    assert detail["progress"]["percent"] == pytest.approx(50.0)

    await client.post("/api/v1/test/login", json={"username": "bob", "role": "user"})
    assert (await client.get(f"/api/v1/books/{book.id}")).json()["progress"] is None


def _table_exists(dsn: str, name: str) -> bool:
    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name = %s", (name,)
        ).fetchone()
    return row is not None


def test_migration_0005_up_and_down(settings: Settings) -> None:
    url = make_url(settings.database_url)
    assert url.host and url.database
    mig_db = "folio_test_progress_migrations"
    dsn = (f"postgresql+psycopg://{url.username}:{url.password}@{url.host}:5432/{mig_db}").replace(
        "postgresql+psycopg", "postgresql", 1
    )
    maint = f"postgresql://{url.username}:{url.password}@{url.host}:5432/postgres"
    with psycopg.connect(maint, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{mig_db}"')
    env = dict(os.environ, DATABASE_URL=dsn, FOLIO_TEST_MODE="false")
    alembic = str(sys_path / ".venv" / "bin" / "alembic")
    try:
        subprocess.run(
            [alembic, "upgrade", "head"], cwd=sys_path, env=env, check=True, capture_output=True
        )
        assert _table_exists(dsn, "progress")
        subprocess.run(
            [alembic, "downgrade", "0004"], cwd=sys_path, env=env, check=True, capture_output=True
        )
        assert not _table_exists(dsn, "progress")
    finally:
        with psycopg.connect(maint, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
