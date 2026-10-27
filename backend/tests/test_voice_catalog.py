"""voice_catalog: language detection/folding, effective defaults, catalog shape."""

from __future__ import annotations

import pytest
from factories import make_book
from sqlalchemy.orm import Session

from folio.models import AppSetting
from folio.tts import Voice
from folio.voice_catalog import (
    VOICE_DEFAULTS_KEY,
    VOICE_LANGUAGES_KEY,
    base_language,
    build_catalog,
    detect_language,
    effective_defaults,
)


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("en", "en"),
        ("en-GB", "en"),
        ("ja", "ja"),
        ("ko", "ko"),
        ("kr", "ko"),
        ("zh", "zh"),
        ("zh-CN", "zh"),
        ("zh-TW", "zh"),
        ("zh-Hans", "zh"),
        ("zh_Hant", "zh"),
        ("ZH-hant", "zh"),
        ("de", None),
        ("Chinese", None),
        ("", None),
        (None, None),
    ],
)
def test_base_language_folds_every_chinese_variant(code: object, expected: str | None) -> None:
    assert base_language(code) == expected


@pytest.mark.parametrize(
    ("voice_id", "field", "expected"),
    [
        ("ashley-en", None, "en"),
        ("ashley-kr", None, "ko"),
        ("mina-zh-TW", None, "zh"),
        ("hana_zh_Hans", None, "zh"),
        ("amy-book", None, None),  # "-book" is not a language token
        ("m1-2-en", None, "en"),
        ("ashley-en", "ja", "ja"),  # the engine field wins over the id
        ("weird", "zh-CN", "zh"),
        ("weird", "French", None),
    ],
)
def test_detect_language(voice_id: str, field: str | None, expected: str | None) -> None:
    assert detect_language(voice_id, field) == expected


def _v(voice_id: str, language: str | None = None) -> Voice:
    return Voice(id=voice_id, language=language)


def test_first_on_server_voice_is_the_automatic_default(db: Session) -> None:
    voices = [_v("tts"), _v("bruno-en", "en"), _v("ashley-en", "en"), _v("hana", "ja")]
    assert effective_defaults(db, voices) == {
        "en": "bruno-en",
        "ja": "hana",
        "ko": None,
        "zh": None,
    }


def test_explicit_default_beats_the_first_voice(db: Session) -> None:
    db.add(AppSetting(key=VOICE_DEFAULTS_KEY, value={"en": "ashley-en"}))
    db.commit()
    voices = [_v("bruno-en", "en"), _v("ashley-en", "en")]
    assert effective_defaults(db, voices)["en"] == "ashley-en"


def test_removed_default_falls_back_to_the_next_voice(db: Session) -> None:
    db.add(AppSetting(key=VOICE_DEFAULTS_KEY, value={"en": "ghost-en"}))
    db.commit()
    voices = [_v("bruno-en", "en"), _v("ashley-en", "en")]
    assert effective_defaults(db, voices)["en"] == "bruno-en"


def test_default_of_the_wrong_language_is_ignored(db: Session) -> None:
    db.add(AppSetting(key=VOICE_DEFAULTS_KEY, value={"en": "hana-ja"}))
    db.commit()
    voices = [_v("bruno-en", "en"), _v("hana-ja", "ja")]
    assert effective_defaults(db, voices)["en"] == "bruno-en"


def test_manual_language_override_wins(db: Session) -> None:
    db.add(AppSetting(key=VOICE_LANGUAGES_KEY, value={"mystery": "zh"}))
    db.commit()
    voices = [_v("mystery")]
    assert effective_defaults(db, voices)["zh"] == "mystery"


def test_catalog_lists_removed_entries_and_counts_books_by_base_language(db: Session) -> None:
    db.add(AppSetting(key=VOICE_DEFAULTS_KEY, value={"zh": "mina-zh"}))
    db.add(AppSetting(key=VOICE_LANGUAGES_KEY, value={"mystery": "ja"}))
    db.commit()
    make_book(db, status="ready", language="en")
    make_book(db, status="ready", language="zh-Hant")
    make_book(db, status="ready", language="de")
    voices = [_v("tts"), _v("ashley-en", "en"), _v("mystery")]
    body = build_catalog(db, voices, include_tts=True)
    by_id = {item["id"]: item for item in body["items"]}
    assert by_id["ashley-en"] == {
        "id": "ashley-en",
        "display_name": "Ashley",
        "language": "en",
        "is_default": True,
        "books_count": 1,
        "on_server": True,
        "language_overridden": False,
        "instructions": "",
    }
    # The assigned voice: overridden flag set, counted as a ja voice (0 books).
    assert by_id["mystery"]["language"] == "ja"
    assert by_id["mystery"]["language_overridden"] is True
    assert by_id["mystery"]["is_default"] is True  # only ja voice -> automatic default
    assert by_id["mystery"]["books_count"] == 0
    # The stored zh default is gone from the engine but still listed, not dropped.
    assert by_id["mina-zh"] == {
        "id": "mina-zh",
        "display_name": "Mina",
        "language": "zh",
        "is_default": False,
        "books_count": 0,
        "on_server": False,
        "language_overridden": False,
        "instructions": "",
    }
    assert body["defaults"] == {"en": "ashley-en", "ja": "mystery", "ko": None, "zh": None}
    assert body["count"] == 2  # tts is not a voice; the ghost is not on the server
