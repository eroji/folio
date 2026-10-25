"""Voices API: engine-discovered voice list and a preview clip (spec: Voice selection → UI)."""

import re
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError
from folio.models import User
from folio.security import require_csrf
from folio.tts import TtsClient, TtsError, discover_voices, get_or_synthesize

router = APIRouter(prefix="/api/v1/voices", tags=["voices"])

_MEDIA_TYPE = {"opus": "audio/ogg", "mp3": "audio/mpeg"}

# Short spoken samples per language; unknown voices fall back to English.
# Non-English samples are pure target-language text (no Latin words): a mixed
# script makes some engines read that word in English (demo finding).
_SAMPLES = {
    "en": "Hello, this is a voice preview from Folio.",
    "ja": "これは音声のプレビューです。",
    "ko": "음성 미리 듣기입니다.",
    "zh": "這是語音預覽。",
}


def get_tts_client() -> Iterator[TtsClient]:
    """TTS client for voice discovery and previews; tests override the transport."""
    with TtsClient(get_settings()) as client:
        yield client


class PreviewBody(BaseModel):
    voice: str = Field(min_length=1, max_length=64)
    text: str | None = Field(default=None, min_length=1, max_length=500)


@router.get("")
def list_voices(
    user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
    refresh: bool = False,
) -> dict[str, Any]:
    # The engine's ``tts`` entry is its internal fallback, not a real voice.
    voices = [v for v in discover_voices(settings, client, refresh=refresh) if v.id != "tts"]
    return {
        "items": [
            {
                "id": v.id,
                "language": v.language,
                "description": v.description,
                "available": v.available,
            }
            for v in voices
        ]
    }


def _default_sample(voice: str, settings: Settings) -> str:
    match = re.search(settings.tts_voice_lang_pattern, voice)
    code = match.group(1).lower() if match and match.lastindex else ""
    if not code:
        # Region suffixes (``ashley-zh-TW``): the language is an earlier part.
        code = next((p for p in voice.lower().split("-") if p in _SAMPLES or p == "kr"), "en")
    return _SAMPLES["ko" if code == "kr" else code]


@router.post("/preview")
def preview_voice(
    request: Request,
    body: PreviewBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
) -> FileResponse:
    """Speak a short sample in ``voice``; cached like any other clip."""
    require_csrf(request, request.state.session_row)
    text = body.text or _default_sample(body.voice, settings)
    try:
        audio, _ = get_or_synthesize(db, settings, client, text, body.voice)
    except (TtsError, httpx.HTTPError):
        raise ApiError("tts_unavailable", "The TTS backend is unreachable.", 502) from None
    path = Path(audio.path)
    if not path.is_file():
        raise ApiError("tts_unavailable", "The TTS backend is unreachable.", 502)
    return FileResponse(path, media_type=_MEDIA_TYPE.get(audio.format, "application/octet-stream"))
