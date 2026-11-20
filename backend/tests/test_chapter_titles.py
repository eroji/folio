"""Untitled chapters are named by their opening words, never by a made-up
"Chapter N" (an EPUB's untitled dedication read "Chapter 1" next to the row
number 1, and the next real chapter was "Chapter One")."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.chapters import display_titles, opening_words
from folio.config import Settings
from folio.ingest import ExtractedChapter
from folio.ingest.pipeline import _persist_chapters
from folio.models import Book, Chapter, Segment

BACKEND = Path(__file__).resolve().parents[1]


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _chapter(idx: int, title: str = "", excluded: bool = False) -> Chapter:
    return Chapter(id=uuid4(), idx=idx, title=title, excluded=excluded, char_count=10)


def test_untitled_chapters_are_named_by_their_opening_words() -> None:
    chapters = [
        _chapter(0, "Copyright", excluded=True),
        _chapter(1, excluded=True),  # an untitled dedication page, turned off
        _chapter(2),
        _chapter(3, "II. Bear"),
        _chapter(4),  # no text at all
    ]
    openings = {
        chapters[1].id: "For my sister, who read every draft.",
        chapters[2].id: "The bed is empty.\n\nNobody has slept in it.",
    }
    titles = display_titles(chapters, openings)
    assert [titles[c.id] for c in chapters] == [
        "Copyright",
        "For my sister, who read every draft.",
        "The bed is empty.",  # the first paragraph only
        "II. Bear",  # a real title is kept
        "Untitled section",
    ]


def test_opening_words_stop_on_a_word_boundary() -> None:
    assert opening_words("This book is dedicated to everyone who stayed up far too late.") == (
        "This book is dedicated to everyone who…"
    )
    assert opening_words("  Short   and\nsweet.  ") == "Short and sweet."
    assert opening_words("Well, then, here we are, all of us, together again; at last.") == (
        "Well, then, here we are, all of us…"  # no comma left before the ellipsis
    )
    assert opening_words("") == ""


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


async def test_book_and_chapter_endpoints_name_untitled_chapters_by_their_text(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = Book(title="Openings", language="en", status="ready", total_chars=30)
    db.add(book)
    db.flush()
    rows = [_chapter(i) for i in range(3)]
    for i, row in enumerate(rows):
        row.book_id = book.id
        db.add(row)
        db.flush()
        for seg_idx, text in enumerate([f"Opening {i}.", "Later text."]):
            db.add(Segment(chapter_id=row.id, idx=seg_idx, text=text, char_start=0, char_end=5))
    db.commit()
    url = f"/api/v1/books/{book.id}"

    body = (await admin_client.get(url)).json()
    assert [c["title"] for c in body["chapters"]] == ["Opening 0.", "Opening 1.", "Opening 2."]

    response = await admin_client.patch(
        f"{url}/chapters/{rows[0].id}", json={"excluded": True}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    assert response.json()["chapter"]["title"] == "Opening 0."  # off, still named
    body = (await admin_client.get(url)).json()
    assert [c["title"] for c in body["chapters"]] == ["Opening 0.", "Opening 1.", "Opening 2."]


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
