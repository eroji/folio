"""Per-chapter progress: every chapter keeps its own position and a listened
flag, so jumping to another chapter never loses the place in the one left."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import httpx
import psycopg
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.models import Book, Chapter, ChapterProgress, Segment, User

BACKEND = Path(__file__).resolve().parents[1]


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _book(db: Session) -> tuple[Book, list[Chapter], dict[int, list[Segment]]]:
    """Three 100-char chapters, segments at char 0, 50 and 85; chapter 1 is off."""
    book = Book(title="Chaptered", language="en", status="ready", total_chars=200)
    db.add(book)
    db.flush()
    chapters: list[Chapter] = []
    segments: dict[int, list[Segment]] = {}
    for idx in range(4):
        chapter = Chapter(
            book_id=book.id, idx=idx, title=f"Ch {idx}", char_count=100, excluded=idx == 1
        )
        db.add(chapter)
        db.flush()
        chapters.append(chapter)
        segments[idx] = []
        for si, start in enumerate((0, 50, 85)):
            segment = Segment(
                chapter_id=chapter.id, idx=si, text=f"s{si}", char_start=start, char_end=start + 30
            )
            db.add(segment)
            segments[idx].append(segment)
    db.commit()
    return book, chapters, segments


async def _save(
    client: httpx.AsyncClient,
    book: Book,
    chapter: Chapter,
    segment: Segment,
    offset_s: float = 0.0,
    **extra: object,
) -> httpx.Response:
    response = await client.put(
        f"/api/v1/books/{book.id}/progress",
        json={
            "chapter_id": str(chapter.id),
            "segment_id": str(segment.id),
            "offset_s": offset_s,
            "device_label": "Phone",
            **extra,
        },
        headers=csrf(client),
    )
    assert response.status_code == 200, response.text
    return response


async def _chapter_progress(client: httpx.AsyncClient, book: Book) -> list[dict | None]:
    body = (await client.get(f"/api/v1/books/{book.id}")).json()
    return [chapter["progress"] for chapter in body["chapters"]]


async def test_each_chapter_keeps_its_own_position(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, chapters, segments = _book(db)
    assert await _chapter_progress(auth_client, book) == [None, None, None, None]

    await _save(auth_client, book, chapters[0], segments[0][1], 4.5)
    # A jump to another chapter (by accident or not) moves the book's resume
    # point but leaves the first chapter's place alone.
    await _save(auth_client, book, chapters[2], segments[2][0], 1.0)

    progress = await _chapter_progress(auth_client, book)
    assert progress[0] == {
        "segment_id": str(segments[0][1].id),
        "offset_s": 4.5,
        "percent": 50.0,
        "finished": False,
    }
    assert progress[1] is None and progress[3] is None
    assert progress[2] is not None and progress[2]["segment_id"] == str(segments[2][0].id)
    book_row = (await auth_client.get(f"/api/v1/books/{book.id}/progress")).json()["progress"]
    assert book_row["chapter_id"] == str(chapters[2].id)


async def test_a_chapter_played_to_its_end_is_listened_and_starts_over(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, chapters, segments = _book(db)
    await _save(auth_client, book, chapters[0], segments[0][2], 9.0, chapter_finished=True)
    progress = await _chapter_progress(auth_client, book)
    # Finished: the next visit starts from the top.
    assert progress[0] == {"segment_id": None, "offset_s": 0.0, "percent": 100.0, "finished": True}

    # Re-listening keeps the listened mark and remembers the new place.
    await _save(auth_client, book, chapters[0], segments[0][1], 2.0)
    progress = await _chapter_progress(auth_client, book)
    assert progress[0] == {
        "segment_id": str(segments[0][1].id),
        "offset_s": 2.0,
        "percent": 50.0,
        "finished": True,
    }


async def test_reset_clears_and_mark_finished_fills_the_chapters(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, chapters, segments = _book(db)
    await _save(auth_client, book, chapters[0], segments[0][1])
    response = await auth_client.put(
        f"/api/v1/books/{book.id}/progress/finished",
        json={"finished": True},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    progress = await _chapter_progress(auth_client, book)
    # Every narrated chapter is listened; the excluded one is untouched.
    assert [p and p["finished"] for p in progress] == [True, None, True, True]

    response = await auth_client.delete(
        f"/api/v1/books/{book.id}/progress", headers=csrf(auth_client)
    )
    assert response.status_code == 204
    assert await _chapter_progress(auth_client, book) == [None, None, None, None]


async def test_chapter_progress_is_per_user(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, chapters, segments = _book(db)
    other = User(ldap_dn="cn=other", username="other", display_name="Other", role="user")
    db.add(other)
    db.flush()
    db.add(
        ChapterProgress(
            user_id=other.id,
            chapter_id=chapters[0].id,
            book_id=book.id,
            segment_id=segments[0][1].id,
            offset_s=3.0,
        )
    )
    db.commit()
    assert await _chapter_progress(auth_client, book) == [None, None, None, None]


def _rows(dsn: str, sql: str) -> list[tuple]:
    with psycopg.connect(dsn) as conn:
        return list(conn.execute(sql).fetchall())


def test_migration_0018_backfills_from_the_book_position(settings: Settings) -> None:
    url = make_url(settings.database_url)
    assert url.host
    port = url.port or 5432
    mig_db = "folio_test_chapter_progress_migrations"
    base = f"postgresql://{url.username}:{url.password}@{url.host}:{port}"
    dsn = f"{base}/{mig_db}"
    with psycopg.connect(f"{base}/postgres", autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{mig_db}"')
    env = dict(
        os.environ,
        DATABASE_URL=dsn.replace("postgresql", "postgresql+psycopg", 1),
        FOLIO_TEST_MODE="false",
    )
    alembic = str(BACKEND / ".venv" / "bin" / "alembic")

    def run(*args: str) -> None:
        subprocess.run([alembic, *args], cwd=BACKEND, env=env, check=True, capture_output=True)

    try:
        run("upgrade", "0017")
        with psycopg.connect(dsn, autocommit=True) as conn:
            user = conn.execute(
                "INSERT INTO users (id, ldap_dn, username, display_name, role) "
                "VALUES (gen_random_uuid(), 'cn=u', 'u', 'U', 'user') RETURNING id"
            ).fetchone()
            assert user is not None

            def book(finished: bool) -> list[tuple]:
                row = conn.execute(
                    "INSERT INTO books (id, title, language, status, total_chars, est_duration_s) "
                    "VALUES (gen_random_uuid(), 'B', 'en', 'ready', 0, 0) RETURNING id"
                ).fetchone()
                assert row is not None
                made = []
                for idx in range(4):
                    chapter = conn.execute(
                        "INSERT INTO chapters (id, book_id, idx, title, char_count, excluded) "
                        "VALUES (gen_random_uuid(), %s, %s, '', 10, %s) RETURNING id",
                        (row[0], idx, idx == 0),
                    ).fetchone()
                    assert chapter is not None
                    segment = conn.execute(
                        "INSERT INTO segments (id, chapter_id, idx, text, char_start, char_end) "
                        "VALUES (gen_random_uuid(), %s, 0, 'x', 0, 1) RETURNING id",
                        (chapter[0],),
                    ).fetchone()
                    assert segment is not None
                    made.append((row[0], chapter[0], segment[0]))
                # Saved in the third chapter (idx 2), 7 s in.
                conn.execute(
                    "INSERT INTO progress (user_id, book_id, chapter_id, segment_id, offset_s, "
                    "percent, finished_at) VALUES (%s, %s, %s, %s, 7, 50, "
                    + ("now()" if finished else "NULL")
                    + ")",
                    (user[0], row[0], made[2][1], made[2][2]),
                )
                return made

            reading = book(finished=False)
            done = book(finished=True)
        run("upgrade", "0018")

        def state(made: list[tuple]) -> list[tuple | None]:
            rows = {
                chapter_id: (segment_id, offset_s, finished)
                for chapter_id, segment_id, offset_s, finished in _rows(
                    dsn,
                    "SELECT chapter_id, segment_id, offset_s, finished_at IS NOT NULL "
                    "FROM chapter_progress",
                )
            }
            return [rows.get(chapter_id) for _, chapter_id, _ in made]

        # Narrated chapters before the saved one were heard; the saved one
        # keeps its place; the excluded one and later ones have nothing.
        assert state(reading) == [None, (None, 0.0, True), (reading[2][2], 7.0, False), None]
        # A finished book has every narrated chapter listened.
        assert state(done) == [None, (None, 0.0, True), (None, 0.0, True), (None, 0.0, True)]
        run("downgrade", "0017")
    finally:
        with psycopg.connect(f"{base}/postgres", autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
