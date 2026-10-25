"""Task B API: GET /voices (engine shape, TTL, refresh) and POST /voices/preview."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from mock_tts import SILENT_OPUS
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.main import create_app
from folio.models import Audio
from folio.routers import voices as voices_module
from folio.tts import TtsClient
from folio.tts.voices import reset_voice_cache

# The verified engine shape (docs/TTS.md).
ENGINE_VOICES = {
    "voices": ["tts", "ashley-zh", "ashley-ja", "ashley-kr", "ashley-en"],
    "uploaded_voices": [
        {"name": "ashley-zh", "description": ""},
        {"name": "ashley-en", "description": "Studio voice"},
    ],
}

Handler = Callable[[httpx.Request], httpx.Response]


class _Handlers:
    """Mutable transport handler so tests can swap behaviour after the client is built."""

    def __init__(self) -> None:
        self.fn: Handler = lambda _request: httpx.Response(200, json=ENGINE_VOICES)

    def dispatch(self, request: httpx.Request) -> httpx.Response:
        return self.fn(request)


@pytest.fixture(autouse=True)
def _fresh_voice_cache() -> None:
    reset_voice_cache()


@pytest.fixture()
def tts_handler() -> _Handlers:
    return _Handlers()


def _app(handler: Handler) -> tuple[FastAPI, Settings]:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        tts_base_url=f"http://voices-{uuid.uuid4().hex[:8]}.test/v1",
        tts_model="tts",
        tts_format="opus",
        tts_default_voice="ashley-en",
    )
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings

    def client_dep() -> TtsClient:
        client = TtsClient(settings)
        client._client = httpx.Client(transport=httpx.MockTransport(handler))
        return client

    app.dependency_overrides[voices_module.get_tts_client] = client_dep
    return app, settings


@pytest.fixture()
async def vclient(db: Session, tts_handler: _Handlers) -> AsyncIterator[httpx.AsyncClient]:
    app, _ = _app(tts_handler.dispatch)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        await client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
        yield client


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def test_default_samples_are_pure_target_language(settings: Settings) -> None:
    # A Latin word in a non-English sample gets read in English (demo finding).
    cases = {
        "ashley-ja": r"[\u3040-\u30ff\u4e00-\u9fff]",  # kana or han
        "ashley-kr": r"[\uac00-\ud7af]",  # hangul syllables
        "ashley-zh": r"[\u4e00-\u9fff]",  # han
    }
    for voice, script in cases.items():
        text = voices_module._default_sample(voice, settings)
        assert re.search(script, text), f"{voice}: {text!r}"
        assert not re.search(r"[A-Za-z]", text), f"{voice}: {text!r}"
    assert voices_module._default_sample("ashley-zh-TW", settings) == voices_module._SAMPLES["zh"]
    assert voices_module._default_sample("tts", settings) == voices_module._SAMPLES["en"]


async def test_voices_list_parses_the_real_engine_shape(
    vclient: httpx.AsyncClient, tts_handler: _Handlers
) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json=ENGINE_VOICES)

    tts_handler.fn = handler
    response = await vclient.get("/api/v1/voices")
    assert response.status_code == 200
    assert seen == ["/v1/audio/voices"]
    items = response.json()["items"]
    # The engine's ``tts`` fallback entry is not a real voice: omitted from the list.
    assert [item["id"] for item in items] == [v for v in ENGINE_VOICES["voices"] if v != "tts"]
    by_id = {item["id"]: item for item in items}
    assert "tts" not in by_id
    assert by_id["ashley-en"] == {
        "id": "ashley-en",
        "language": "en",
        "description": "Studio voice",
        "available": True,
        # All four ashley voices derive "Ashley" -> the language disambiguates.
        "display_name": "Ashley (EN)",
    }
    assert by_id["ashley-kr"]["language"] == "ko"  # kr -> ko (docs/TTS.md)


async def test_voices_requires_session() -> None:
    app, _ = _app(lambda _request: httpx.Response(200, json=ENGINE_VOICES))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://testserver"
    ) as client:
        assert (await client.get("/api/v1/voices")).status_code == 401


async def test_voices_ttl_cache_and_refresh_bypass(
    vclient: httpx.AsyncClient, tts_handler: _Handlers
) -> None:
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ENGINE_VOICES)

    tts_handler.fn = handler
    assert (await vclient.get("/api/v1/voices")).status_code == 200
    await vclient.get("/api/v1/voices")
    assert calls["n"] == 1  # served from the TTL cache
    await vclient.get("/api/v1/voices?refresh=true")
    assert calls["n"] == 2  # refresh bypasses it


async def test_preview_returns_audio_bytes_and_caches(
    vclient: httpx.AsyncClient, tts_handler: _Handlers, db: Session
) -> None:
    speech_calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/audio/voices":
            return httpx.Response(200, json=ENGINE_VOICES)
        speech_calls["n"] += 1
        body: dict[str, Any] = json.loads(request.content)
        assert body["voice"] == "ashley-en" and body["speed"] == 1.0
        assert "Folio" in body["input"]  # default English sample
        return httpx.Response(200, content=SILENT_OPUS, headers={"content-type": "audio/ogg"})

    tts_handler.fn = handler
    response = await vclient.post(
        "/api/v1/voices/preview", json={"voice": "ashley-en"}, headers=csrf(vclient)
    )
    assert response.status_code == 200
    assert response.content == SILENT_OPUS
    assert response.headers["content-type"] == "audio/ogg"
    assert speech_calls["n"] == 1
    assert db.scalar(select(Audio)) is not None

    again = await vclient.post(
        "/api/v1/voices/preview", json={"voice": "ashley-en"}, headers=csrf(vclient)
    )
    assert again.status_code == 200 and again.content == SILENT_OPUS
    assert speech_calls["n"] == 1  # cached via get_or_synthesize, no second synthesis


async def test_preview_requires_csrf_and_maps_tts_errors_to_502(
    vclient: httpx.AsyncClient,
    tts_handler: _Handlers,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("folio.tts.client.time.sleep", lambda _s: None)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/audio/voices":
            return httpx.Response(200, json=ENGINE_VOICES)
        return httpx.Response(500)

    tts_handler.fn = handler
    assert (
        await vclient.post("/api/v1/voices/preview", json={"voice": "ashley-en"})
    ).status_code == 403  # no CSRF header
    response = await vclient.post(
        "/api/v1/voices/preview",
        json={"voice": "ashley-en", "text": "This will not be spoken."},
        headers=csrf(vclient),
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "tts_unavailable"
