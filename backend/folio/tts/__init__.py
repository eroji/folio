"""TTS core: client, voice discovery, cache, synthesis, eviction, selection.

The public surface other M4 workstreams import. Names and signatures are pinned
by ``docs/superpowers/plans/2026-10-24-m4-tts-player.md`` (Task A).
"""

from dataclasses import dataclass


class TtsError(Exception):
    """A TTS backend could not be reached or refused the request."""

    def __init__(self, message: str, code: str = "tts_error") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


@dataclass
class Voice:
    """A voice reported by the engine (or the ``TTS_VOICES`` fallback)."""

    id: str
    language: str | None = None
    description: str | None = None
    available: bool = True


from folio.tts.cache import (
    cache_key,
    cache_path,
    duration_seconds,
    evict_if_needed,
    get_or_synthesize,
)
from folio.tts.client import TtsClient
from folio.tts.select import select_voice
from folio.tts.text import normalize_speech_text, prepare_for_speech
from folio.tts.voices import discover_voices

__all__ = [
    "TtsClient",
    "TtsError",
    "Voice",
    "cache_key",
    "cache_path",
    "discover_voices",
    "duration_seconds",
    "evict_if_needed",
    "get_or_synthesize",
    "normalize_speech_text",
    "prepare_for_speech",
    "select_voice",
]
