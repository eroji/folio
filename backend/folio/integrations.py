"""Admin-set integrations: provider API keys and the language model.

Stored in ``app_settings`` under ``integrations`` so an admin can change them
without touching the server's environment. Keys are secrets: they are read
here and sent to their provider, never returned to a browser (the admin API
shows only whether one is set and its last four characters) and never logged.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import TYPE_CHECKING, Any

from folio.models import AppSetting

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from folio.config import Settings

KEY = "integrations"


@dataclass(frozen=True)
class LanguageModel:
    """An OpenAI-compatible chat completions endpoint (``base_url`` ends in /v1)."""

    base_url: str = ""
    api_key: str = ""
    model: str = ""
    # A vision model for OCR when the chat model cannot read images; empty: ``model``.
    ocr_model: str = ""
    ocr: bool = False  # read scanned PDFs at import
    suggest: bool = False  # suggest pronunciation rules + a delivery note at import
    # Off: every request asks the model not to think first (chat template
    # ``enable_thinking: false``). Folio's tasks gain nothing from it, and a
    # thinking model can spend a whole answer budget before answering.
    thinking: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.base_url.strip() and self.model.strip())

    @property
    def reader(self) -> str:
        return self.ocr_model.strip() or self.model.strip()

    @property
    def ocr_ready(self) -> bool:
        return self.configured and self.ocr

    @property
    def suggest_ready(self) -> bool:
        return self.configured and self.suggest


@dataclass(frozen=True)
class Integrations:
    google_books_api_key: str = ""
    language_model: LanguageModel = field(default_factory=LanguageModel)


def _str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _parse(raw: Any) -> Integrations:
    data = raw if isinstance(raw, dict) else {}
    found = data.get("language_model")
    llm: dict[str, Any] = found if isinstance(found, dict) else {}
    return Integrations(
        google_books_api_key=_str(data.get("google_books_api_key")),
        language_model=LanguageModel(
            base_url=_str(llm.get("base_url")),
            api_key=_str(llm.get("api_key")),
            model=_str(llm.get("model")),
            ocr_model=_str(llm.get("ocr_model")),
            ocr=llm.get("ocr") is True,
            suggest=llm.get("suggest") is True,
            thinking=llm.get("thinking") is True,
        ),
    )


def load_integrations(db: Session) -> Integrations:
    row = db.get(AppSetting, KEY)
    return _parse(row.value if row else None)


def save_integrations(db: Session, value: Integrations) -> None:
    """Upsert (the caller commits)."""
    row = db.get(AppSetting, KEY)
    payload = asdict(value)
    if row is None:
        db.add(AppSetting(key=KEY, value=payload))
    else:
        row.value = payload


def update_language_model(current: Integrations, **changes: Any) -> Integrations:
    return replace(current, language_model=replace(current.language_model, **changes))


def google_books_key(db: Session, settings: Settings) -> str:
    """The admin's key, else ``GOOGLE_BOOKS_API_KEY`` from the environment."""
    return load_integrations(db).google_books_api_key or settings.google_books_api_key


def key_hint(secret: str) -> str | None:
    """What the admin page shows of a stored key: its last four characters."""
    if not secret:
        return None
    return f"…{secret[-4:]}" if len(secret) > 8 else "set"
