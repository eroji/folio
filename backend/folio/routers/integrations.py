"""Admin → Metadata (provider API keys) and Admin → AI (the language model).

GET shows the settings with keys masked (set or not, last four characters);
PUT changes what it is given (a key left out stays, an empty one is removed).
The test endpoints try a draft before it is saved: fields left out fall back
to the saved values, so "Test" works on the form as typed.
"""

from __future__ import annotations

from io import BytesIO
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Form, Request, UploadFile
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import require_admin
from folio.errors import ApiError
from folio.ingest.ocr import first_page_jpeg
from folio.integrations import (
    Integrations,
    LanguageModel,
    key_hint,
    load_integrations,
    save_integrations,
)
from folio.llm import LlmError, chat, list_models, read_page
from folio.metadata import googlebooks
from folio.security import require_csrf
from folio.tts.narration import style_prompts_on

router = APIRouter(
    prefix="/api/v1/admin/integrations", tags=["admin"], dependencies=[Depends(require_admin)]
)

MAX_TEST_BYTES = 15 * 1024 * 1024
SAMPLE_TEXT = (
    "It was the best of times, it was the worst of times,\n"
    "it was the age of wisdom, it was the age of foolishness,\n"
    "it was the epoch of belief, it was the epoch of incredulity."
)
_IMAGES = {
    b"\x89PNG": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF8": "image/gif",
    b"RIFF": "image/webp",
}


class LanguageModelBody(BaseModel):
    base_url: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=200)
    ocr_model: str | None = Field(default=None, max_length=200)
    # None removes the key; leave the field out to keep it.
    api_key: str | None = Field(default=None, max_length=500)
    ocr: bool | None = None
    suggest: bool | None = None
    thinking: bool | None = None


class IntegrationsBody(BaseModel):
    google_books_api_key: str | None = Field(default=None, max_length=500)
    language_model: LanguageModelBody | None = None


class GoogleTestBody(BaseModel):
    api_key: str | None = Field(default=None, max_length=500)


def _public(value: Integrations, settings: Settings, db: DbSession) -> dict[str, Any]:
    llm = value.language_model
    return {
        "google_books": {
            "key_set": bool(value.google_books_api_key),
            "key_hint": key_hint(value.google_books_api_key),
            # The server's GOOGLE_BOOKS_API_KEY is used while no key is set here.
            "env_key": bool(settings.google_books_api_key),
        },
        "language_model": {
            "base_url": llm.base_url,
            "model": llm.model,
            "ocr_model": llm.ocr_model,
            "ocr": llm.ocr,
            "suggest": llm.suggest,
            "thinking": llm.thinking,
            "key_set": bool(llm.api_key),
            "key_hint": key_hint(llm.api_key),
        },
        # Voice and book delivery notes reach the engine only when this is on.
        "style_prompts": style_prompts_on(db, settings),
    }


def _check_url(url: str) -> str:
    url = url.strip()
    if url and not url.startswith(("http://", "https://")):
        raise ApiError(
            "validation_failed", "The base URL must start with http:// or https://.", 422
        )
    return url


def _merged(saved: LanguageModel, draft: LanguageModelBody) -> LanguageModel:
    """The saved model with the draft's provided fields on top."""
    given = draft.model_fields_set
    return LanguageModel(
        base_url=_check_url(draft.base_url or "") if "base_url" in given else saved.base_url,
        model=(draft.model or "").strip() if "model" in given else saved.model,
        ocr_model=(draft.ocr_model or "").strip() if "ocr_model" in given else saved.ocr_model,
        api_key=(draft.api_key or "").strip() if "api_key" in given else saved.api_key,
        ocr=draft.ocr if draft.ocr is not None else saved.ocr,
        suggest=draft.suggest if draft.suggest is not None else saved.suggest,
        thinking=draft.thinking if draft.thinking is not None else saved.thinking,
    )


@router.get("")
def get_integrations(
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return _public(load_integrations(db), settings, db)


@router.put("")
def put_integrations(
    request: Request,
    body: IntegrationsBody,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    current = load_integrations(db)
    google = current.google_books_api_key
    if "google_books_api_key" in body.model_fields_set:
        google = (body.google_books_api_key or "").strip()
    llm = current.language_model
    if body.language_model is not None:
        llm = _merged(llm, body.language_model)
        if (llm.ocr or llm.suggest) and not llm.configured:
            raise ApiError(
                "validation_failed", "Set the base URL and model before switching features on.", 422
            )
    updated = Integrations(google_books_api_key=google, language_model=llm)
    save_integrations(db, updated)
    db.commit()
    return _public(updated, settings, db)


@router.post("/google-books/test")
def test_google_books(
    request: Request,
    body: GoogleTestBody,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    if "api_key" in body.model_fields_set:
        key = (body.api_key or "").strip()
    else:
        key = load_integrations(db).google_books_api_key or settings.google_books_api_key
    with httpx.Client(timeout=10.0) as client:
        ok, message = googlebooks.probe(client, key)
    return {"ok": ok, "message": message}


@router.post("/language-model/test")
def test_language_model(
    request: Request,
    body: LanguageModelBody,
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """A one-line chat with the chat model, then a word from the reading model
    when OCR uses a different one."""
    require_csrf(request, request.state.session_row)
    cfg = _merged(load_integrations(db).language_model, body)
    try:
        reply = chat(
            cfg,
            [{"role": "user", "content": "Reply with exactly the word: ready"}],
            max_tokens=200,
            timeout=60,
        )
    except LlmError as exc:
        return {"ok": False, "message": str(exc)}
    message = f"{reply.model} answered in {reply.latency_ms} ms."
    if reply.reasoning_tokens and not cfg.thinking:
        message += (
            f" It still thought first ({reply.reasoning_tokens} reasoning tokens): this server"
            " ignores the request not to think, which slows every task."
        )
    elif reply.reasoning_tokens:
        message += f" It thought first ({reply.reasoning_tokens} reasoning tokens)."
    return {
        "ok": True,
        "message": message,
        "reply": reply.text[:200],
        "latency_ms": reply.latency_ms,
        "model": reply.model,
        "reasoning_tokens": reply.reasoning_tokens,
    }


@router.post("/language-model/models")
def list_language_models(
    request: Request,
    body: LanguageModelBody,
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """The models the endpoint offers, for the model pickers (the draft base URL
    and key, else the saved ones)."""
    require_csrf(request, request.state.session_row)
    cfg = _merged(load_integrations(db).language_model, body)
    try:
        return {"ok": True, "models": list_models(cfg)}
    except LlmError as exc:
        return {"ok": False, "message": str(exc), "models": []}


def sample_page() -> bytes:
    """A small printed page for the OCR test when no file is given."""
    image = Image.new("RGB", (1100, 420), "white")
    draw = ImageDraw.Draw(image)
    try:
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont = ImageFont.load_default(size=34)
    except (TypeError, OSError):  # Pillow without FreeType: the small bitmap font
        font = ImageFont.load_default()
    draw.multiline_text((50, 60), SAMPLE_TEXT, fill="black", font=font, spacing=28)
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _image(data: bytes) -> tuple[bytes, str]:
    if data.startswith(b"%PDF"):
        try:
            return first_page_jpeg(data), "image/jpeg"
        except (LlmError, RuntimeError, ValueError):  # a broken or empty PDF
            raise ApiError("validation_failed", "That PDF could not be opened.", 422) from None
    for magic, mime in _IMAGES.items():
        if data.startswith(magic):
            return data, mime
    raise ApiError("validation_failed", "Upload a PNG, JPEG, GIF or WebP image, or a PDF.", 422)


@router.post("/language-model/test-ocr")
def test_ocr(
    request: Request,
    db: Annotated[DbSession, Depends(get_session)],
    file: UploadFile | None = None,
    base_url: Annotated[str | None, Form(max_length=500)] = None,
    model: Annotated[str | None, Form(max_length=200)] = None,
    ocr_model: Annotated[str | None, Form(max_length=200)] = None,
    api_key: Annotated[str | None, Form(max_length=500)] = None,
) -> dict[str, Any]:
    """Read the built-in sample page (or an uploaded image / a PDF's first
    page) with the reading model; ``expected`` is the sample's text."""
    require_csrf(request, request.state.session_row)
    draft = {
        name: value
        for name, value in (
            ("base_url", base_url),
            ("model", model),
            ("ocr_model", ocr_model),
            ("api_key", api_key),
        )
        if value is not None
    }
    cfg = _merged(load_integrations(db).language_model, LanguageModelBody(**draft))
    expected: str | None = None
    if file is None:
        image, mime, expected = sample_page(), "image/png", SAMPLE_TEXT
    else:
        data = file.file.read(MAX_TEST_BYTES + 1)
        if len(data) > MAX_TEST_BYTES:
            raise ApiError("too_large", "The test file must be under 15 MB.", 413)
        image, mime = _image(data)
    try:
        reply = read_page(cfg, image, mime)
    except LlmError as exc:
        return {"ok": False, "message": str(exc), "expected": expected}
    return {
        "ok": bool(reply.text.strip()),
        "message": f"{reply.model} read the page in {reply.latency_ms} ms."
        if reply.text.strip()
        else f"{reply.model} answered but found no text on the page.",
        "text": reply.text,
        "expected": expected,
        "latency_ms": reply.latency_ms,
        "model": reply.model,
    }
