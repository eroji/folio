"""Untitled chapters are numbered among the chapters set to narrate, not by
their position in the source file (an EPUB's front matter used to push the
first real chapter to "Chapter 7")."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.chapters import display_titles
from folio.config import Settings
from folio.ingest import ExtractedChapter
from folio.ingest.pipeline import _persist_chapters
from folio.models import Book, Chapter

BACKEND = Path(__file__).resolve().parents[1]


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _chapter(idx: int, title: str = "", excluded: bool = False) -> Chapter:
    return Chapter(id=uuid4(), idx=idx, title=title, excluded=excluded, char_count=10)


def test_untitled_chapters_count_among_the_narrated_ones() -> None:
    chapters = [
        _chapter(0, "Copyright", excluded=True),
        _chapter(1, excluded=True),  # an untitled dedication page, turned off
        _chapter(2),
        _chapter(3),
        _chapter(4, "II. Bear"),
        _chapter(5),
    ]
    titles = display_titles(chapters)
    assert [titles[c.id] for c in chapters] == [
        "Copyright",
        "Untitled section",
        "Chapter 1",
        "Chapter 2",
        "II. Bear",  # a real title is kept, and still counts as position 3
        "Chapter 4",  # matches the book page's row number
    ]


def test_ingest_stores_no_made_up_title(db: Session, settings: Settings) -> None:
    book = Book(title="Untitled Chapters", language="en", status="processing")
    db.add(book)
    db.flush()
    _persist_chapters(
        db,
        settings,
        book,
        [
            ExtractedChapter(title="", text="Front matter text here."),
            ExtractedChapter(title="Prologue", text="It began at the harbour."),
        ],
    )
    db.commit()
    stored = db.query(Chapter).filter(Chapter.book_id == book.id).order_by(Chapter.idx).all()
    assert [c.title for c in stored] == ["", "Prologue"]


async def test_book_and_chapter_endpoints_renumber_after_an_exclusion(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = Book(title="Numbered", language="en", status="ready", total_chars=30)
    db.add(book)
    db.flush()
    rows = [_chapter(i) for i in range(3)]
    for row in rows:
        row.book_id = book.id
        db.add(row)
    db.commit()
    url = f"/api/v1/books/{book.id}"

    body = (await admin_client.get(url)).json()
    assert [c["title"] for c in body["chapters"]] == ["Chapter 1", "Chapter 2", "Chapter 3"]

    response = await admin_client.patch(
        f"{url}/chapters/{rows[0].id}", json={"excluded": True}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["chapter"]["title"] == "Untitled section"
    body = (await admin_client.get(url)).json()
    assert [c["title"] for c in body["chapters"]] == ["Untitled section", "Chapter 1", "Chapter 2"]


def _titles(dsn: str) -> list[str]:
    with psycopg.connect(dsn) as conn:
        return [row[0] for row in conn.execute("SELECT title FROM chapters ORDER BY idx")]


def test_migration_0016_clears_generated_titles_and_restores_them(settings: Settings) -> None:
    url = make_url(settings.database_url)
    assert url.host
    port = url.port or 5432
    mig_db = "folio_test_chapter_title_migrations"
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
        run("upgrade", "0015")
        with psycopg.connect(dsn, autocommit=True) as conn:
            book = conn.execute(
                "INSERT INTO books (id, title, language, status, total_chars, est_duration_s) "
                "VALUES (gen_random_uuid(), 'B', 'en', 'ready', 0, 0) RETURNING id"
            ).fetchone()
            assert book is not None
            for idx, title in enumerate(["Chapter 1", "Prologue", "Chapter 9", "Chapter 4"]):
                conn.execute(
                    "INSERT INTO chapters (id, book_id, idx, title, char_count) "
                    "VALUES (gen_random_uuid(), %s, %s, %s, 10)",
                    (book[0], idx, title),
                )
        run("upgrade", "0016")
        # Only titles the importer made up ("Chapter {idx + 1}") are cleared.
        assert _titles(dsn) == ["", "Prologue", "Chapter 9", ""]
        run("downgrade", "0015")
        assert _titles(dsn) == ["Chapter 1", "Prologue", "Chapter 9", "Chapter 4"]
    finally:
        with psycopg.connect(f"{base}/postgres", autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
