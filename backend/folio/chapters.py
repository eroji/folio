"""Chapter titles as listeners see them.

A chapter whose source has no title (an EPUB spine document missing from the
table of contents, a PDF without an outline) is stored with an empty title and
shown by its opening words ("This book is dedicated to…"). Nothing is made
up: a "Chapter N" label repeated the row number beside it, and next to the
book's own "Chapter One" an untitled dedication read "Chapter 1".
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.models import Chapter, Segment

UNTITLED = "Untitled section"
_MAX_OPENING = 40


def opening_words(text: str) -> str:
    """The first paragraph, cut on a word boundary near ``_MAX_OPENING``."""
    paragraph = " ".join(text.strip().split("\n\n", 1)[0].split())
    if len(paragraph) <= _MAX_OPENING:
        return paragraph
    cut = paragraph[: _MAX_OPENING + 1].rsplit(" ", 1)[0] if " " in paragraph else paragraph
    return cut[:_MAX_OPENING].rstrip(" ,;:—–-") + "…"


def chapter_openings(db: Session, chapters: Sequence[Chapter]) -> dict[UUID, str]:
    """``chapter.id -> first segment text`` for the untitled chapters only."""
    untitled = [c.id for c in chapters if not c.title.strip()]
    if not untitled:
        return {}
    rows = db.execute(
        select(Segment.chapter_id, Segment.text).where(
            Segment.chapter_id.in_(untitled), Segment.idx == 0
        )
    ).all()
    return {chapter_id: text for chapter_id, text in rows}


def display_titles(chapters: Iterable[Chapter], openings: Mapping[UUID, str]) -> dict[UUID, str]:
    """``chapter.id -> title``; ``openings`` comes from ``chapter_openings``."""
    titles: dict[UUID, str] = {}
    for chapter in chapters:
        title = chapter.title.strip() or opening_words(openings.get(chapter.id, ""))
        titles[chapter.id] = title or UNTITLED
    return titles
