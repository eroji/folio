"""Voice display names: derived from the voice id, admin-overridable.

``ashley-en`` reads as *Ashley*: strip the language suffix, split on ``-``/``_``
and capitalise each word (``ashley-en`` -> ``Ashley``). Voices are always shown
inside a language-specific row, so the same base name is not disambiguated.
Admin overrides live in ``app_settings`` under ``voice_names``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from folio.models import AppSetting

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

VOICE_NAMES_KEY = "voice_names"
MAX_NAME_LENGTH = 40

_LANG_SUFFIX = re.compile(r"-(?:en|ja|kr|ko|zh)(?:-[A-Za-z]{2})?$", re.IGNORECASE)


def default_display_name(voice_id: str) -> str:
    base = _LANG_SUFFIX.sub("", voice_id)
    words = [word for word in re.split(r"[-_]", base) if word]
    return " ".join(word.capitalize() for word in words) or voice_id


def resolve_display_names(
    voices: Sequence[tuple[str, str | None]], overrides: Mapping[str, str]
) -> dict[str, str]:
    """id -> name for each ``(id, language)`` voice; overrides win."""
    return {
        voice_id: overrides.get(voice_id) or default_display_name(voice_id)
        for voice_id, _language in voices
    }


def load_overrides(db: Session) -> dict[str, str]:
    row = db.get(AppSetting, VOICE_NAMES_KEY)
    return {str(key): str(value) for key, value in row.value.items()} if row is not None else {}


def save_overrides(db: Session, names: Mapping[str, str]) -> dict[str, str]:
    """Replace the override map (empty values dropped); return what was saved."""
    saved = {key: value.strip() for key, value in names.items() if value.strip()}
    row = db.get(AppSetting, VOICE_NAMES_KEY)
    if saved:
        if row is None:
            db.add(AppSetting(key=VOICE_NAMES_KEY, value=saved))
        else:
            row.value = saved  # new object: JSONB mutation detection needs it
    elif row is not None:
        db.delete(row)
    db.commit()
    return saved
