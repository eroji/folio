"""Runtime voice discovery and the ``TTS_VOICES`` fallback.

The engine is the source of truth (spec: Voice selection → Discovery); a voice
added to the engine shows up without a code change or restart. The list is
cached for ``TTS_VOICES_TTL`` seconds; ``refresh=True`` bypasses the cache.
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

from folio.config import Settings
from folio.tts import TtsError, Voice

if TYPE_CHECKING:
    from folio.tts.client import TtsClient

# base_url -> (monotonic expiry, voices)
_CACHE: dict[str, tuple[float, list[Voice]]] = {}


def _language(field: Any, voice_id: str, settings: Settings) -> str | None:
    """The ``language`` field if present, else the id suffix, else None."""
    if field:
        return str(field)
    match = re.search(settings.tts_voice_lang_pattern, voice_id)
    if match and match.lastindex:
        code = match.group(1).lower()
        return "ko" if code == "kr" else code
    return None


def parse_voices_payload(payload: Any, settings: Settings) -> list[Voice]:
    """Accept a list of ids, a list of objects, or either wrapped as a dict.

    Also merges ``uploaded_voices[].name``/``description`` onto matching ids.
    """
    uploaded: dict[str, str | None] = {}
    items: Any = payload
    if isinstance(payload, dict):
        for entry in payload.get("uploaded_voices") or []:
            if isinstance(entry, dict) and entry.get("name"):
                uploaded[str(entry["name"])] = entry.get("description") or None
        items = payload.get("voices") or payload.get("data") or []
    if not isinstance(items, list):
        return []

    voices: list[Voice] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            voice_id, language, description = item, None, uploaded.get(item)
        elif isinstance(item, dict):
            raw_id = item.get("id") or item.get("name")
            if not raw_id:
                continue
            voice_id = str(raw_id)
            language = item.get("language")
            description = item.get("description") or uploaded.get(voice_id)
        else:
            continue
        if voice_id in seen:
            continue
        seen.add(voice_id)
        voices.append(
            Voice(
                id=voice_id,
                language=_language(language, voice_id, settings),
                description=description,
                available=True,
            )
        )
    return voices


def _fallback(settings: Settings) -> list[Voice]:
    """Comma-separated ``TTS_VOICES``, marked unavailable (the engine is down)."""
    return [
        Voice(id=name.strip(), language=_language(None, name.strip(), settings), available=False)
        for name in settings.tts_voices.split(",")
        if name.strip()
    ]


def discover_voices(settings: Settings, client: TtsClient, refresh: bool = False) -> list[Voice]:
    """Return the engine's voices, or the ``TTS_VOICES`` fallback if unreachable."""
    key = (settings.tts_base_url or "").rstrip("/")
    now = time.monotonic()
    if not refresh:
        hit = _CACHE.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]
    try:
        voices = client.list_voices()
    except TtsError:
        voices = _fallback(settings)
    _CACHE[key] = (now + settings.tts_voices_ttl, voices)
    return voices


def reset_voice_cache() -> None:
    """Clear the TTL cache (tests; the admin 'Refresh voices' button uses refresh=True)."""
    _CACHE.clear()
