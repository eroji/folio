"""Chapters with (almost) nothing to say start switched off: part-title pages
("II Bear"), separators and empty shells would be a 0-3 s entry in the
chapter list. The owner can switch any of them back on under Manage."""

from __future__ import annotations

from sqlalchemy.orm import Session

from folio.config import Settings
from folio.ingest import ExtractedChapter
from folio.ingest.pipeline import _persist_chapters
from folio.models import Book, Chapter

STORY = "The bed is empty, and the counselors are already awake. " * 3


def _store(
    db: Session, settings: Settings, chapters: list[ExtractedChapter]
) -> tuple[Book, list[Chapter]]:
    book = Book(title="Parts", language="en", status="processing")
    db.add(book)
    db.flush()
    _persist_chapters(db, settings, book, chapters)
    db.commit()
    stored = db.query(Chapter).filter(Chapter.book_id == book.id).order_by(Chapter.idx).all()
    return book, stored


def test_part_titles_and_wordless_chapters_start_off(db: Session, settings: Settings) -> None:
    book, stored = _store(
        db,
        settings,
        [
            ExtractedChapter(title="II. Bear", text="II\nBear"),  # a part-title page, ~0.5 s
            ExtractedChapter(title="Louise", text=STORY),
            ExtractedChapter(title="", text="* * *\n—"),  # no words at all
            # Exactly 3 s at the default 15 chars/s is still too short ...
            ExtractedChapter(title="Short", text="x" * 45),
            # ... a dedication just past it stays on, as before.
            ExtractedChapter(
                title="Dedication", text="For my sister, Rebecca, who also knows these woods"
            ),
        ],
    )
    assert [c.excluded for c in stored] == [True, False, True, True, False]
    # The book's length counts only what will be narrated.
    assert book.total_chars == len(STORY.strip()) + len(
        "For my sister, Rebecca, who also knows these woods"
    )


def test_the_threshold_follows_the_configured_speech_rate(db: Session, settings: Settings) -> None:
    slow = settings.model_copy(update={"tts_chars_per_second": 5.0})  # 3 s = 15 chars
    _, stored = _store(
        db,
        slow,
        [ExtractedChapter(title="A", text="x" * 20), ExtractedChapter(title="B", text=STORY)],
    )
    assert [c.excluded for c in stored] == [False, False]


def test_a_book_of_only_short_chapters_keeps_them_on(db: Session, settings: Settings) -> None:
    _, stored = _store(
        db,
        settings,
        [
            ExtractedChapter(title="Copyright", text="All rights reserved.", excluded=True),
            ExtractedChapter(title="Poem", text="So much depends upon"),
            ExtractedChapter(title="Coda", text="a red wheel barrow"),
        ],
    )
    # Switching these off would leave nothing to play: the rule stands aside.
    assert [c.excluded for c in stored] == [True, False, False]
