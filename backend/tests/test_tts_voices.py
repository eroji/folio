"""Voice discovery: payload shapes, language inference, TTL cache, fallback."""

from __future__ import annotations

from typing import Any

import pytest

from folio.config import Settings
from folio.tts import TtsError, Voice
from folio.tts import voices as voices_mod
from folio.tts.voices import discover_voices, parse_voices_payload


def _settings(**over: Any) -> Settings:
    base: dict[str, Any] = {
        "tts_base_url": "http://tts.test/v1",
        "tts_voice_lang_pattern": "-(en|ja|kr|ko|zh)$",
        "tts_voices_ttl": 600,
    }
    base.update(over)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


class _FakeClient:
    def __init__(self, result: list[Voice] | None = None, error: Exception | None = None) -> None:
        self.result = result or []
        self.error = error
        self.calls = 0

    def list_voices(self) -> list[Voice]:
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    voices_mod.reset_voice_cache()
    yield
    voices_mod.reset_voice_cache()


def test_parses_array_of_strings() -> None:
    voices = parse_voices_payload(["ashley-en", "tts"], _settings())
    assert [(v.id, v.language) for v in voices] == [("ashley-en", "en"), ("tts", None)]


def test_parses_array_of_objects_with_id_and_name() -> None:
    voices = parse_voices_payload([{"id": "a"}, {"name": "b"}], _settings())
    assert [v.id for v in voices] == ["a", "b"]


def test_parses_wrapped_voices_and_data() -> None:
    assert [v.id for v in parse_voices_payload({"voices": ["x"]}, _settings())] == ["x"]
    assert [v.id for v in parse_voices_payload({"data": [{"id": "y"}]}, _settings())] == ["y"]


def test_merges_uploaded_voices_description() -> None:
    payload = {
        "voices": ["tts", "ashley-en"],
        "uploaded_voices": [{"name": "ashley-en", "description": "Warm female"}],
    }
    voices = parse_voices_payload(payload, _settings())
    by_id = {v.id: v for v in voices}
    assert by_id["ashley-en"].description == "Warm female"
    assert by_id["tts"].description is None


def test_language_field_beats_id_suffix() -> None:
    voices = parse_voices_payload([{"id": "ashley-en", "language": "fr"}], _settings())
    assert voices[0].language == "fr"


def test_kr_suffix_maps_to_ko() -> None:
    assert parse_voices_payload(["ashley-kr"], _settings())[0].language == "ko"
    assert parse_voices_payload(["ashley-ja"], _settings())[0].language == "ja"


def test_discover_caches_until_ttl_and_refresh_bypasses() -> None:
    client = _FakeClient(result=[Voice("ashley-en", language="en")])
    settings = _settings()
    discover_voices(settings, client)
    discover_voices(settings, client)
    assert client.calls == 1  # second served from the TTL cache
    discover_voices(settings, client, refresh=True)
    assert client.calls == 2  # refresh bypasses the cache


def test_discover_falls_back_to_tts_voices_when_engine_fails() -> None:
    client = _FakeClient(error=TtsError("down"))
    voices = discover_voices(_settings(tts_voices="ashley-en, ashley-kr"), client)
    assert [(v.id, v.language, v.available) for v in voices] == [
        ("ashley-en", "en", False),
        ("ashley-kr", "ko", False),
    ]


def test_discover_marks_engine_voices_available() -> None:
    client = _FakeClient(result=[Voice("ashley-en", language="en")])
    assert discover_voices(_settings(), client)[0].available is True
