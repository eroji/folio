"""Per-book pronunciation rules applied before ``normalize_speech_text``.

Each rule replaces ``match`` with ``say`` in one pass over the current text,
in creation order, so text introduced by an earlier rule is visible to later
rules but never re-matched by the rule that produced it.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from folio.models.book import PronunciationRule


def _pattern(rule: PronunciationRule) -> re.Pattern[str]:
    pattern = re.escape(rule.match)
    if rule.whole_word:
        pattern = rf"\b{pattern}\b"
    if rule.after_number:
        # Python lookbehinds must be fixed-width, so spell out both cases.
        pattern = rf"(?:(?<=\d)|(?<=\d\s)){pattern}"
    flags = 0 if rule.case_sensitive else re.IGNORECASE
    return re.compile(pattern, flags)


def apply_rules(text: str, rules: list[PronunciationRule]) -> str:
    """Rewrite ``text`` through ``rules`` (creation order); the speech-ready text."""
    out = text
    for rule in rules:
        # Escape backslashes so re.sub treats ``say`` as a literal, not a template.
        out = _pattern(rule).sub(rule.say.replace("\\", r"\\"), out)
    return out
