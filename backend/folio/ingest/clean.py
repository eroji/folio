"""Text cleaning for speech (spec ingestion step 4).

Removing repeated PDF running headers/footers is the PDF extractor's job
(T5a), not this module's.
"""

from __future__ import annotations

import dataclasses
import re
import unicodedata
from typing import Any

# Zero-width characters and the soft hyphen carry no sound; NFKC does not strip them.
_INVISIBLE = dict.fromkeys(map(ord, "\u00ad\u200b\u200c\u200d\u2060\ufeff"))

# A hyphen at a line break is a wrap artifact ("exam-\nple" -> "example").
_HYPHEN_BREAK = re.compile(r"[-\u2010][ \t]*\n[ \t]*(?=(\w))")


def _dehyphen(match: re.Match[str]) -> str:
    # Lowercase continuation: join the word. Capital: keep the hyphen, drop the
    # break ("Gross-\nBaum" -> "Gross-Baum", never "Gross- Baum").
    # ponytail: no dictionary check, so "well-\nknown" joins to "wellknown";
    # upgrade only if hyphenated compounds at line breaks show up in real books.
    return "" if match.group(1).islower() else "-"


def clean_text(raw: str, language: str) -> str:
    """Normalise extracted chapter text for speech.

    ``language`` is part of the pinned T5b interface; cleaning itself is
    language-independent today.
    """
    text = unicodedata.normalize("NFKC", raw).translate(_INVISIBLE)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _HYPHEN_BREAK.sub(_dehyphen, text)
    text = re.sub(r"[^\S\n]+", " ", text)  # horizontal whitespace runs -> one space
    text = re.sub(r" ?\n ?", "\n", text)  # whitespace around line breaks
    text = re.sub(r"\n{3,}", "\n\n", text)  # many blank lines -> one paragraph break
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)  # lone line break -> space
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def clean_chapters(chapters: list[Any], language: str) -> list[Any]:
    """Return chapters (duck-typed ``.title``/``.text``) with cleaned text.

    Rebuilds each chapter with ``dataclasses.replace`` so the result keeps the
    input type — T5a's ``ExtractedChapter`` is a dataclass.
    """
    return [dataclasses.replace(c, text=clean_text(c.text, language)) for c in chapters]
