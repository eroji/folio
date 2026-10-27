"""Voice catalog metadata: per-language server defaults and language overrides.

``app_settings`` keys (next to ``voice_names``, see ``voice_names.py``):

- ``voice_defaults``: base language (en/ja/ko/zh) -> voice id, the server-wide
  default for that language. No entry (or a stale one) means "the first
  on-server voice of that language", which is what makes defaults automatic.
- ``voice_languages``: voice id -> base language, the admin's override for
  voices whose language cannot be detected (or detected wrongly).
- ``voice_instructions``: voice id -> narration instruction, the admin's global
  style prompt sent with every synthesis in that voice (see ``tts/narration.py``).

Ids that carry an entry but are no longer on the engine are listed with
``on_server: false`` instead of being silently dropped, so admins can clean
them up (DELETE /admin/voices/{id}); nothing new is stored for them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from folio.models import AppSetting, Book
from folio.tts import Voice
from folio.voice_names import default_display_name, load_overrides

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

VOICE_DEFAULTS_KEY = "voice_defaults"
VOICE_LANGUAGES_KEY = "voice_languages"
VOICE_INSTRUCTIONS_KEY = "voice_instructions"
MAX_INSTRUCTION_LENGTH = 500
BASE_LANGUAGES = ("en", "ja", "ko", "zh")

# Trailing language token of a voice id: ``-en``, ``-kr``, ``mina-zh-TW``,
# ``hana_zh_Hans``. Region/script parts are matched and folded by base_language.
_ID_LANG = re.compile(r"[-_](en|ja|ko|kr|zh)(?:[-_][A-Za-z]{2,4})?\Z", re.IGNORECASE)


def base_language(code: object) -> str | None:
    """Base language of a code: ``zh-Hant`` -> ``zh``, ``kr`` -> ``ko``; else None."""
    if not isinstance(code, str):
        return None
    base = re.split(r"[-_]", code.strip(), maxsplit=1)[0].lower()
    base = "ko" if base == "kr" else base
    return base if base in BASE_LANGUAGES else None


def detect_language(voice_id: str, engine_field: str | None) -> str | None:
    """Engine ``language`` field first, then the id's trailing language token."""
    language = base_language(engine_field)
    if language:
        return language
    match = _ID_LANG.search(voice_id)
    return base_language(match.group(1)) if match else None


def _load_map(db: Session, key: str) -> dict[str, str]:
    row = db.get(AppSetting, key)
    return {str(k): str(v) for k, v in row.value.items()} if row is not None else {}


def _save_map(db: Session, key: str, value: Mapping[str, str]) -> None:
    row = db.get(AppSetting, key)
    if value:
        if row is None:
            db.add(AppSetting(key=key, value=dict(value)))
        else:
            row.value = dict(value)  # rebind: JSONB mutation detection needs a new object
    elif row is not None:
        db.delete(row)
    db.commit()


def load_voice_defaults(db: Session) -> dict[str, str]:
    return _load_map(db, VOICE_DEFAULTS_KEY)


def save_voice_defaults(db: Session, value: Mapping[str, str]) -> None:
    _save_map(db, VOICE_DEFAULTS_KEY, value)


def load_voice_languages(db: Session) -> dict[str, str]:
    return _load_map(db, VOICE_LANGUAGES_KEY)


def save_voice_languages(db: Session, value: Mapping[str, str]) -> None:
    _save_map(db, VOICE_LANGUAGES_KEY, value)


def load_voice_instructions(db: Session) -> dict[str, str]:
    return _load_map(db, VOICE_INSTRUCTIONS_KEY)


def save_voice_instructions(db: Session, value: Mapping[str, str]) -> dict[str, str]:
    """Replace the instruction map (trimmed-empty values dropped); return what was saved."""
    saved = {key: text.strip() for key, text in value.items() if text.strip()}
    _save_map(db, VOICE_INSTRUCTIONS_KEY, saved)
    return saved


def voice_languages(db: Session, voices: Sequence[Voice]) -> dict[str, str | None]:
    """id -> base language; the manual override wins over detection. ``tts`` is
    the engine's internal fallback, not a voice, and never appears here."""
    overrides = load_voice_languages(db)
    return {
        v.id: base_language(overrides.get(v.id)) or detect_language(v.id, v.language)
        for v in voices
        if v.id != "tts"
    }


def effective_defaults(db: Session, voices: Sequence[Voice]) -> dict[str, str | None]:
    """Per base language: the stored default when it is still on-server and of
    that language, else the first on-server voice of that language (engine
    order). A default whose voice disappeared therefore falls back by itself."""
    stored = load_voice_defaults(db)
    language = voice_languages(db, voices)
    real = [v.id for v in voices if v.id != "tts"]
    out: dict[str, str | None] = {}
    for base in BASE_LANGUAGES:
        explicit = stored.get(base)
        if explicit is not None and language.get(explicit) == base:
            out[base] = explicit
        else:
            out[base] = next((i for i in real if language.get(i) == base), None)
    return out


def _books_per_language(db: Session) -> dict[str, int]:
    counts: dict[str, int] = {}
    for code, n in db.execute(select(Book.language, func.count()).group_by(Book.language)):
        base = base_language(code)
        if base:
            counts[base] = counts.get(base, 0) + int(n)
    return counts


def build_catalog(db: Session, voices: Sequence[Voice], *, include_tts: bool) -> dict[str, Any]:
    """GET /voices body: items (on-server first, then removed entries sorted
    by id) plus the effective per-language defaults and the on-server count."""
    names = load_overrides(db)
    stored_defaults = load_voice_defaults(db)
    languages = load_voice_languages(db)
    instructions = load_voice_instructions(db)
    language = voice_languages(db, voices)
    defaults = effective_defaults(db, voices)
    counts = _books_per_language(db)

    def item(voice_id: str, *, language_of: str | None, on_server: bool) -> dict[str, Any]:
        return {
            "id": voice_id,
            "display_name": names.get(voice_id) or default_display_name(voice_id),
            "language": language_of,
            "is_default": (
                language_of is not None and on_server and voice_id == defaults.get(language_of)
            ),
            "books_count": counts.get(language_of, 0) if language_of and on_server else 0,
            "on_server": on_server,
            "language_overridden": voice_id in languages,
            "instructions": instructions.get(voice_id, ""),
        }

    items = [
        item(v.id, language_of=language.get(v.id), on_server=True)
        for v in voices
        if v.id != "tts" or include_tts
    ]
    known = {v.id for v in voices}
    items += [
        item(
            voice_id,
            language_of=base_language(languages.get(voice_id)) or detect_language(voice_id, None),
            on_server=False,
        )
        for voice_id in sorted({*names, *languages, *stored_defaults.values()} - known)
    ]
    return {"items": items, "defaults": defaults, "count": len(known - {"tts"})}
