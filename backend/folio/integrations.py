"""Admin-set integrations: provider API keys, the language model and the TTS server.

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


#: Bounds of the admin's TTS concurrency (TTS_CONCURRENCY has no upper bound).
TTS_CONCURRENCY_MIN = 1
TTS_CONCURRENCY_MAX = 16
#: Longest sentence request when the admin picks "One sentence each" and
#: TTS_REQUEST_CHARS is 0 (the whole-segment default).
SENTENCE_REQUEST_CHARS = 400


@dataclass(frozen=True)
class TtsServer:
    """The OpenAI-compatible TTS server (``base_url`` ends in /v1).

    Empty ``base_url``: ``TTS_BASE_URL`` + ``TTS_API_KEY`` from the environment.
    ``model`` empty: ``TTS_MODEL``. ``concurrency`` None: ``TTS_CONCURRENCY``.
    ``sentence_requests`` None: ``TTS_REQUEST_CHARS``; True: one request per
    sentence; False: one request per segment. See ``apply_tts``.
    """

    base_url: str = ""
    api_key: str = ""
    concurrency: int | None = None
    sentence_requests: bool | None = None
    model: str = ""


@dataclass(frozen=True)
class Integrations:
    google_books_api_key: str = ""
    language_model: LanguageModel = field(default_factory=LanguageModel)
    tts: TtsServer = field(default_factory=TtsServer)


def _str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def valid_concurrency(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and TTS_CONCURRENCY_MIN <= value <= TTS_CONCURRENCY_MAX
    )


def _parse(raw: Any) -> Integrations:
    data = raw if isinstance(raw, dict) else {}
    found = data.get("language_model")
    llm: dict[str, Any] = found if isinstance(found, dict) else {}
    found_tts = data.get("tts")
    tts: dict[str, Any] = found_tts if isinstance(found_tts, dict) else {}
    concurrency = tts.get("concurrency")
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
        tts=TtsServer(
            base_url=_str(tts.get("base_url")),
            api_key=_str(tts.get("api_key")),
            concurrency=concurrency if valid_concurrency(concurrency) else None,
            sentence_requests=(
                tts["sentence_requests"] if isinstance(tts.get("sentence_requests"), bool) else None
            ),
            model=_str(tts.get("model")),
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


def apply_tts(tts: TtsServer, settings: Settings) -> Settings:
    """``settings`` with the admin's TTS server on top (a copy; never mutated).

    An admin base URL replaces ``TTS_BASE_URL`` together with the admin key,
    even an empty one: the environment's ``TTS_API_KEY`` is never sent to a
    server the admin typed in. Without an admin URL the environment's URL and
    key stand (an admin key alone is unused). The admin model replaces
    ``TTS_MODEL`` whichever server is in effect; an empty one keeps the
    environment's. The admin concurrency replaces ``TTS_CONCURRENCY`` whichever
    server is in effect. The admin's request choice replaces
    ``TTS_REQUEST_CHARS``: one sentence each uses it when it is above 0, else
    ``SENTENCE_REQUEST_CHARS``; whole segment is 0.
    """
    update: dict[str, Any] = {}
    if tts.base_url:
        update["tts_base_url"] = tts.base_url
        update["tts_api_key"] = tts.api_key
    if tts.model:
        update["tts_model"] = tts.model
    if tts.concurrency is not None:
        update["tts_concurrency"] = tts.concurrency
    if tts.sentence_requests is True:
        update["tts_request_chars"] = settings.tts_request_chars or SENTENCE_REQUEST_CHARS
    elif tts.sentence_requests is False:
        update["tts_request_chars"] = 0
    return settings.model_copy(update=update) if update else settings


def effective_tts_settings(db: Session, settings: Settings) -> Settings:
    """The settings every TTS path uses, read from the database at the point of
    use so the API and the worker pick up an admin change on their next request
    or job, without a restart."""
    return apply_tts(load_integrations(db).tts, settings)


def key_hint(secret: str) -> str | None:
    """What the admin page shows of a stored key: its last four characters."""
    if not secret:
        return None
    return f"…{secret[-4:]}" if len(secret) > 8 else "set"
