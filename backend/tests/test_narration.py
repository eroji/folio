"""Per-voice narration instructions: storage, prompt building, cache-key effect."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from folio.config import Settings
from folio.models import AppSetting
from folio.tts import cache_key, get_or_synthesize
from folio.tts.narration import DEFAULT_INSTRUCTION, narration_prompt
from folio.voice_catalog import load_voice_instructions, save_voice_instructions

MYSTERY = "You're narrating a Mystery novel."


def _row(db: Session):
    return db.get(AppSetting, "voice_instructions")


def test_save_load_roundtrip_trims_and_empty_removes_entry(db: Session) -> None:
    saved = save_voice_instructions(db, {"ashley-en": "  Warm, expressive  ", "bruno-en": ""})
    assert saved == {"ashley-en": "Warm, expressive"}
    assert load_voice_instructions(db) == {"ashley-en": "Warm, expressive"}
    assert _row(db).value == {"ashley-en": "Warm, expressive"}  # stored like voice_names

    assert save_voice_instructions(db, {"ashley-en": ""}) == {}
    assert _row(db) is None  # last entry gone: the row is deleted
    assert load_voice_instructions(db) == {}


def test_narration_prompt_punctuation_and_genre(db: Session) -> None:
    save_voice_instructions(db, {"ashley-en": "Warm, expressive, speak with a brisk pace"})
    assert (
        narration_prompt(db, "ashley-en", "Mystery")
        == "Warm, expressive, speak with a brisk pace. " + MYSTERY
    )
    assert narration_prompt(db, "ashley-en", None) == "Warm, expressive, speak with a brisk pace."
    assert narration_prompt(db, "ashley-en", "  ") == "Warm, expressive, speak with a brisk pace."
    # Already-terminal punctuation is not doubled.
    for end in (".", "!", "?"):
        save_voice_instructions(db, {"v": f"Calm tone{end}"})
        assert narration_prompt(db, "v", "Mystery") == f"Calm tone{end} " + MYSTERY
    # No instruction: the default style, plus the genre sentence when there is one.
    assert narration_prompt(db, "ghost", "Mystery") == DEFAULT_INSTRUCTION + " " + MYSTERY
    assert narration_prompt(db, "ghost", None) == DEFAULT_INSTRUCTION
    # The default never goes out as an empty instructions field.
    assert narration_prompt(db, "ghost", None) != ""


def test_cache_key_instructions_are_optional_and_isolate(db: Session) -> None:
    plain = cache_key("tts", "ashley-en", "opus", "hello world")
    assert cache_key("tts", "ashley-en", "opus", "hello world", "") == plain  # old keys survive
    assert cache_key("tts", "ashley-en", "opus", "hello world", "Warm tone.") != plain
    assert cache_key("tts", "ashley-en", "opus", "hello world", "Calm tone.") != plain


class _CapturingClient:
    def __init__(self) -> None:
        from mock_tts import SILENT_OPUS

        self.data = SILENT_OPUS
        self.instructions: list[str | None] = []

    def synthesize(
        self, _text: str, _voice: str, instructions: str | None = None
    ) -> tuple[bytes, str]:
        self.instructions.append(instructions)
        return self.data, "opus"


def test_get_or_synthesize_passes_instructions_to_the_client(
    db: Session, settings: Settings
) -> None:
    client = _CapturingClient()
    get_or_synthesize(db, settings, client, "hi", "ashley-en")
    assert client.instructions == [""]  # default: unchanged behaviour and key
    row, cached = get_or_synthesize(db, settings, client, "hi", "ashley-en", "Warm tone.")
    assert cached is False and client.instructions == ["", "Warm tone."]  # new key -> miss
    again, cached = get_or_synthesize(db, settings, client, "hi", "ashley-en", "Warm tone.")
    assert cached is True and len(client.instructions) == 2
    assert again.cache_key == cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        "hi",
        "Warm tone.",
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    assert Path(row.path).is_file()
