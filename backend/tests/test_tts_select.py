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


def test_first_voice_for_language_when_unmapped() -> None:
    # No config for ko: the first discovered ko voice wins over the default.
    settings = _settings(tts_voice_map={"en": "ashley-en"})
    book = Book(status="ready", language="ko", title="B")
    voices = [
        Voice(id="tts"),
        Voice(id="ashley-en", language="en"),
        Voice(id="ashley-kr", language="ko"),
        Voice(id="bruno-kr", language="ko"),
    ]
    assert select_voice(book, {}, settings, voices) == "ashley-kr"


def test_zh_tw_falls_back_to_first_zh_voice() -> None:
    settings = _settings(tts_voice_map={})
    book = Book(status="ready", language="zh-TW", title="B")
    voices = [Voice(id="ashley-en", language="en"), Voice(id="mina-zh", language="zh")]
    assert select_voice(book, {}, settings, voices) == "mina-zh"


def test_kr_language_code_normalizes_to_ko() -> None:
    settings = _settings(tts_voice_map={})
    book = Book(status="ready", language="ko", title="B")
    assert select_voice(book, {}, settings, [Voice(id="ashley-kr", language="kr")]) == "ashley-kr"


def test_tts_fallback_voice_is_never_selected() -> None:
    # The engine's ``tts`` entry is its internal fallback, not a real voice.
    settings = _settings(tts_voice_map={}, tts_default_voice="tts")
    book = Book(status="ready", language="en", title="B")
    got = select_voice(book, {}, settings, [Voice(id="tts"), Voice(id="ashley-en", language="en")])
    assert got == "ashley-en"
    with pytest.raises(TtsError):  # nothing but tts: no voice, not the fallback
        select_voice(book, {}, settings, [Voice(id="tts")])


def test_saved_unavailable_voice_falls_to_first_for_language() -> None:
    settings = _settings(tts_voice_map={}, tts_default_voice="someone-else")
    book = Book(status="ready", language="ja", title="B", narrator_voice="gone-ja")
    voices = [Voice(id="tts"), Voice(id="hana-ja", language="ja")]
    assert select_voice(book, {}, settings, voices) == "hana-ja"


def test_server_default_beats_voice_map() -> None:
    # Admin-set default wins over TTS_VOICE_MAP.
    book = Book(status="ready", language="en", title="B")
    voices = [Voice(id="bruno-en", language="en"), Voice(id="ashley-en", language="en")]
    got = select_voice(book, {}, _settings(), voices, {"en": "bruno-en", "ja": None})
    assert got == "bruno-en"


def test_stale_server_default_falls_through_to_voice_map() -> None:
    book = Book(status="ready", language="en", title="B")
    voices = [Voice(id="ashley-en", language="en")]
    got = select_voice(book, {}, _settings(), voices, {"en": "gone-en"})
    assert got == "ashley-en"  # via TTS_VOICE_MAP; the gone default is skipped


def test_server_default_beats_first_voice_of_language() -> None:
    settings = _settings(tts_voice_map={})
    book = Book(status="ready", language="ko", title="B")
    voices = [Voice(id="bruno-kr", language="ko"), Voice(id="hana-kr", language="ko")]
    got = select_voice(book, {}, settings, voices, {"ko": "hana-kr"})
    assert got == "hana-kr"


def test_user_voice_must_match_the_book_language() -> None:
    # A pinned en voice for a ja book falls through to the server default.
    book = Book(status="ready", language="ja", title="B")
    voices = [Voice(id="ashley-en", language="en"), Voice(id="hana-ja", language="ja")]
    got = select_voice(
        book, {"voices": {"ja": "ashley-en"}}, _settings(), voices, {"ja": "hana-ja"}
    )
    assert got == "hana-ja"


def test_user_voice_keyed_by_legacy_region_folds_to_base() -> None:
    # Old rows still key by zh-TW; the zh-Hant book must find the pin.
    book = Book(status="ready", language="zh-Hant", title="B")
    voices = [Voice(id="mina-zh", language="zh"), Voice(id="ashley-en", language="en")]
    got = select_voice(book, {"voices": {"zh-TW": "mina-zh"}}, _settings(), voices, {"zh": None})
    assert got == "mina-zh"


def test_removed_user_voice_falls_back_to_server_default() -> None:
    book = Book(status="ready", language="en", title="B")
    voices = [Voice(id="ashley-en", language="en")]
    got = select_voice(
        book, {"voices": {"en": "gone-en"}}, _settings(), voices, {"en": "ashley-en"}
    )
    assert got == "ashley-en"
