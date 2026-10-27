"""The ``instructions`` string sent to the TTS engine for one synthesis.

Per voice (``app_settings.voice_instructions``, see ``voice_catalog.py``): the
admin's style instruction for the voice being used, plus the book's genre.
Empty when there is nothing to say -- the request then carries no
``instructions`` field and the audio cache keys stay what they were.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from folio.voice_catalog import load_voice_instructions

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

_SENTENCE_END = (".", "!", "?")


def narration_prompt(db: Session, voice: str, genre: str | None) -> str:
    """The voice's instruction (made sentence-terminal) + the genre sentence."""
    instruction = load_voice_instructions(db).get(voice, "").strip()
    genre = (genre or "").strip()
    if not instruction:
        return f"You're narrating a {genre} novel." if genre else ""
    if not instruction.endswith(_SENTENCE_END):
        instruction += "."
    if genre:
        instruction += f" You're narrating a {genre} novel."
    return instruction
