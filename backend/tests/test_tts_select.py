"""select_voice: order, zh-TW -> zh, unavailable-voice fall-through."""

from __future__ import annotations

from typing import Any

import pytest

from folio.config import Settings
from folio.models.book import Book
from folio.tts import TtsError, Voice, select_voice


def _settings(**over: Any) -> Settings:
    base: dict[str, Any] = {
        "tts_default_voice": "ashley-en",
        "tts_voice_map": {
            "en": "ashley-en",
            "ja": "ashley-ja",
            "ko": "ashley-kr",
            "zh": "ashley-zh",
        },
    }
    base.update(over)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


def _voices(*ids: str) -> list[Voice]:
    return [Voice(id=i) for i in ids]


def test_book_narrator_override_wins() -> None:
    book = Book(status="ready", language="en", title="B", narrator_voice="serena")
    got = select_voice(book, {}, _settings(), _voices("serena", "ashley-en"))
    assert got == "serena"


def test_user_per_language_voice() -> None:
    book = Book(status="ready", language="ja", title="B")
    settings = _settings()
    got = select_voice(
        book, {"voices": {"ja": "custom-ja"}}, settings, _voices("custom-ja", "ashley-ja")
    )
    assert got == "custom-ja"


def test_zh_tw_uses_admin_zh_default_not_en() -> None:
    # Review focus 3: a zh-TW book with no per-book voice gets ashley-zh.
    book = Book(status="ready", language="zh-TW", title="B")
    got = select_voice(book, {}, _settings(), _voices("ashley-zh", "ashley-en"))
    assert got == "ashley-zh"


def test_voice_map_beats_default() -> None:
    book = Book(status="ready", language="ko", title="B")
    got = select_voice(book, {}, _settings(), _voices("ashley-kr", "ashley-en"))
    assert got == "ashley-kr"


def test_default_voice_when_language_unmapped() -> None:
    book = Book(status="ready", language="de", title="B")
    got = select_voice(book, {}, _settings(), _voices("ashley-en"))
    assert got == "ashley-en"


def test_disappeared_voice_falls_through() -> None:
    # Review focus 5: the saved narrator voice vanished from the engine.
    book = Book(status="ready", language="en", title="B", narrator_voice="gone-voice")
    got = select_voice(book, {}, _settings(), _voices("ashley-en"))
    assert got == "ashley-en"


def test_empty_voice_list_skips_availability_check() -> None:
    # No engine voices reported: the configured voice is used without a membership check.
    book = Book(status="ready", language="en", title="B")
    assert select_voice(book, {}, _settings(), []) == "ashley-en"


def test_raises_when_nothing_resolves() -> None:
    book = Book(status="ready", language="en", title="B")
    with pytest.raises(TtsError):
        select_voice(book, {}, _settings(), _voices("someone-else"))
