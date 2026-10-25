"""Voice selection order (spec: Voice selection → Selection order)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from folio.config import Settings
from folio.tts import TtsError, Voice

if TYPE_CHECKING:
    from folio.models.book import Book


def _lang_base(code: str) -> str:
    """Base language of a BCP-47-ish code: ``zh-TW`` -> ``zh``, ``kr`` -> ``ko``."""
    base = code.split("-")[0].lower()
    return "ko" if base == "kr" else base


def select_voice(
    book: Book, user_settings: dict[str, Any], settings: Settings, voices: list[Voice]
) -> str:
    """book override → user per-language → TTS_VOICE_MAP[lang] → first voice
    for the language → TTS_DEFAULT_VOICE.

    A chosen voice that is not among ``voices`` (when the engine reported any)
    falls through to the next rule, so a voice removed from the engine never
    500s playback. The engine's ``tts`` entry is its internal fallback, not a
    real voice, and is never selected. Raises TtsError when nothing resolves.
    """
    language = book.language or "en"
    # Membership by id only: a voice the engine no longer lists is simply absent,
    # while a TTS_VOICES fallback voice (available=False) still counts as usable.
    known = {v.id for v in voices} if voices else None

    def usable(candidate: object) -> bool:
        if not isinstance(candidate, str) or not candidate or candidate == "tts":
            return False
        return known is None or candidate in known

    if usable(book.narrator_voice):
        return str(book.narrator_voice)

    user_voices = user_settings.get("voices") or {}
    if isinstance(user_voices, dict) and usable(user_voices.get(language)):
        return str(user_voices[language])

    for key in (language, language.split("-")[0]):  # zh-TW -> zh
        if usable(settings.tts_voice_map.get(key)):
            return str(settings.tts_voice_map[key])

    base = _lang_base(language)
    for voice in voices:  # nothing configured: the first discovered voice for the language
        if voice.id != "tts" and voice.language and _lang_base(voice.language) == base:
            return voice.id

    if usable(settings.tts_default_voice):
        return str(settings.tts_default_voice)

    raise TtsError("No TTS voice is available for this book", code="no_voice")
