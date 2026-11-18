"""The ``suggest`` job: the language model reads a book's details and a sample
of its text, and proposes pronunciation rules and a delivery note.

Proposed rules are stored ``suggested`` — they change nothing about the audio
until the owner accepts them under Manage. The delivery note is written only
while nobody has edited it by hand (``locked_fields``). Every rule must match
text that is really in the book, so an invented word never lands.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.integrations import load_integrations
from folio.llm import LlmError, chat, parse_json
from folio.models import Book, Chapter, Job, PronunciationRule, Segment

logger = logging.getLogger(__name__)

MAX_RULES = 25
MAX_NOTE_CHARS = 600
EXCERPT_CHARS = 3000
MAX_NAMES = 60
DESCRIPTION_CHARS = 1500

SYSTEM = (
    "You prepare books for audiobooks narrated by a text-to-speech engine. Answer with "
    "one JSON object only, no prose: "
    '{"delivery_note": string, "rules": [{"match": string, "say": string, "whole_word": boolean}]}.\n'
    "delivery_note: one or two sentences of narration direction for this book: tone, pace, "
    "mood, era or setting, and how the dialogue should feel. No plot, no spoilers, no "
    "character names. Write it in English.\n"
    "rules: words in this book that a speech engine is likely to mispronounce: unusual or "
    "invented names and places, foreign words, archaic spellings, abbreviations. For each, "
    "`match` is the word exactly as written in the book and `say` is a respelling that the "
    "engine will read correctly, in the book's own script, using plain syllables (for "
    'example "Siobhan" -> "Shiv-awn", "Hermione" -> "Her-my-oh-nee"). Never IPA. Skip '
    "ordinary words and names every reader already says correctly. Set whole_word true "
    f"unless the match is part of longer words. At most {MAX_RULES} rules; an empty list "
    "is a fine answer."
)

_CAPITALISED = re.compile(r"(?<=[^.!?\s]\s)([A-Z][\w'’-]*\w)")
_FOREIGN_LATIN = re.compile(r"\b\w*[À-ɏ]\w*\b")


def _frequent_names(text: str) -> list[str]:
    """Capitalised words that are not starting a sentence, and words with
    accented letters — the usual mispronunciation suspects — most frequent first."""
    counts = Counter(m.group(1) for m in _CAPITALISED.finditer(text))
    counts.update(m.group(0) for m in _FOREIGN_LATIN.finditer(text))
    return [word for word, n in counts.most_common(MAX_NAMES * 2) if n >= 2 and len(word) > 2][
        :MAX_NAMES
    ]


def _book_text(session: Session, book: Book) -> str:
    """The narrated text, chapter by chapter (for names and the excerpt)."""
    rows = session.execute(
        select(Segment.text)
        .join(Chapter, Chapter.id == Segment.chapter_id)
        .where(Chapter.book_id == book.id, Chapter.excluded.is_(False))
        .order_by(Chapter.idx, Segment.idx)
    ).scalars()
    return "".join(rows)


def _prompt(book: Book, text: str) -> str:
    lines = [
        f"Title: {book.title}",
        f"Author: {', '.join(book.authors) or 'unknown'}",
        f"Language: {book.language}",
    ]
    if book.genre:
        lines.append(f"Genre: {book.genre}")
    if book.description:
        lines.append(f"Description: {book.description[:DESCRIPTION_CHARS]}")
    names = _frequent_names(text)
    if names:
        lines.append("Frequent names and unusual words: " + ", ".join(names))
    lines.append("Excerpt:\n" + text[:EXCERPT_CHARS])
    return "\n".join(lines)


def _in_book(session: Session, book: Book, match: str) -> bool:
    return (
        session.scalar(
            select(Segment.id)
            .join(Chapter, Chapter.id == Segment.chapter_id)
            .where(
                Chapter.book_id == book.id, func.strpos(func.lower(Segment.text), match.lower()) > 0
            )
            .limit(1)
        )
        is not None
    )


def _rules(session: Session, book: Book, raw: Any) -> list[PronunciationRule]:
    existing = {
        m.lower()
        for m in session.scalars(
            select(PronunciationRule.match).where(
                PronunciationRule.book_id == book.id, PronunciationRule.suggested.is_(False)
            )
        )
    }
    out: list[PronunciationRule] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        match = str(item.get("match") or "").strip()[:200]
        say = str(item.get("say") or "").strip()[:200]
        key = match.lower()
        if not match or not say or key == say.lower() or key in existing or key in seen:
            continue
        if not _in_book(session, book, match):
            continue  # the model invented it
        seen.add(key)
        out.append(
            PronunciationRule(
                book_id=book.id,
                match=match,
                say=say,
                whole_word=item.get("whole_word") is not False,
                suggested=True,
            )
        )
        if len(out) == MAX_RULES:
            break
    return out


def suggest_for_book(session: Session, settings: Settings, target: UUID | Job) -> None:
    book_id = target.book_id if isinstance(target, Job) else target
    book = session.get(Book, book_id) if book_id else None
    if book is None:
        return
    model = load_integrations(session).language_model
    if not model.configured:
        raise LlmError("The language model is not set up (Admin → Integrations).")
    text = _book_text(session, book)
    if not text.strip():
        return
    reply = chat(
        model,
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(book, text)}],
        max_tokens=2000,
    )
    data = parse_json(reply.text)
    if not isinstance(data, dict):
        raise LlmError("The language model's answer was not a JSON object.")
    rules = _rules(session, book, data.get("rules"))
    # A new run replaces the previous suggestions; accepted rules stay.
    session.execute(
        delete(PronunciationRule).where(
            PronunciationRule.book_id == book.id, PronunciationRule.suggested.is_(True)
        )
    )
    session.add_all(rules)
    note = " ".join(str(data.get("delivery_note") or "").split())[:MAX_NOTE_CHARS]
    if note and "delivery_note" not in book.locked_fields:
        book.delivery_note = note
    session.commit()
    logger.info("suggest book %s: %d rules, note %s", book.id, len(rules), "yes" if note else "no")
