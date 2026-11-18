"""The ``instructions`` string sent to the TTS engine for one synthesis.

The admin's per-voice style instruction (``app_settings.voice_instructions``,
see ``voice_catalog.py``) falls back to ``DEFAULT_INSTRUCTION`` — how this
narrator performs, on every book — plus the book's delivery note (what this
book needs: tone, pace, setting), else a sentence naming its genre. Every synthesis carries a prompt: measured on the engine, an instructions
field is what makes it pause between sentences instead of running them together.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from folio.voice_catalog import load_voice_instructions

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from folio.config import Settings

# Voice style used whenever a voice has no admin override, so a voice added to
# the engine inherits the house narration without anyone setting it up.
DEFAULT_INSTRUCTION = (
    "Perform this like a seasoned audiobook narrator: emotionally engaged, never monotone. "
    "Vary pitch, pace and emphasis with the text. Soften for tension, lift the energy for "
    "action, and give each character of dialogue a subtly distinct voice. Leave a short pause "
    "between sentences and a longer one at scene breaks."
)

_SENTENCE_END = (".", "!", "?")


def engine_instructions(
    db: Session, settings: Settings, voice: str, genre: str | None, note: str | None = None
) -> str:
    """What to send as ``instructions`` (and key the cache with): the narration
    prompt, or nothing when ``TTS_INSTRUCTIONS`` is off for this engine."""
    return narration_prompt(db, voice, genre, note) if settings.tts_instructions else ""


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text.endswith(_SENTENCE_END) else text + "."


def narration_prompt(db: Session, voice: str, genre: str | None, note: str | None = None) -> str:
    """The voice's instruction (admin override, else the default) + the book's
    delivery note, or the genre sentence when the book has no note."""
    instruction = _sentence(load_voice_instructions(db).get(voice, "") or DEFAULT_INSTRUCTION)
    note = _sentence(note or "")
    genre = (genre or "").strip()
    if note:
        instruction += f" {note}"
    elif genre:
        instruction += f" You're narrating a {genre} novel."
    return instruction
