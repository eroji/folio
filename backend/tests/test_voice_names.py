"""Voice display names: id parsing, collision suffixes, admin overrides (app_settings)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.main import create_app
from folio.routers import voices as voices_module
from folio.tts import TtsClient
from folio.tts.voices import reset_voice_cache
from folio.voice_names import default_display_name, resolve_display_names

ENGINE_VOICES: dict[str, Any] = {
    "voices": ["tts", "ashley-zh", "ashley-ja", "ashley-kr", "ashley-en"]
}

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def _fresh_voice_cache() -> None:
    reset_voice_cache()


def _app() -> FastAPI:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        tts_base_url=f"http://names-{uuid.uuid4().hex[:8]}.test/v1",  # unique: no TTL cache bleed
        tts_model="tts",
        tts_format="opus",
        tts_default_voice="ashley-en",
    )
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings

    def client_dep() -> TtsClient:
        client = TtsClient(settings)
        client._client = httpx.Client(
            transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=ENGINE_VOICES))
        )
        return client

    app.dependency_overrides[voices_module.get_tts_client] = client_dep
    return app


async def _client(app: FastAPI, role: str) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        username = "testadmin" if role == "admin" else "testuser"
        await client.post("/api/v1/test/login", json={"username": username, "role": role})
        yield client


@pytest.fixture()
def vapp(db: Session) -> FastAPI:
    return _app()


@pytest.fixture()
async def vclient(vapp: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async for client in _client(vapp, "admin"):
        yield client


@pytest.fixture()
async def uclient(vapp: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async for client in _client(vapp, "user"):
        yield client


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


@pytest.mark.parametrize(
    ("voice_id", "expected"),
    [
        ("ashley-en", "Ashley"),
        ("ashley-ja", "Ashley"),
        ("ashley-kr", "Ashley"),
        ("ashley-ko", "Ashley"),
        ("ashley-zh", "Ashley"),
        ("ashley-zh-TW", "Ashley"),
        ("ashley-en-US", "Ashley"),
        ("amy-book", "Amy Book"),
        ("amy_book", "Amy Book"),
        ("tts", "Tts"),
    ],
)
def test_default_display_name(voice_id: str, expected: str) -> None:
    assert default_display_name(voice_id) == expected


def test_collision_appends_language() -> None:
    voices = [("ashley-en", "en"), ("ashley-ja", "ja"), ("amy", "en")]
    assert resolve_display_names(voices, {}) == {
        "ashley-en": "Ashley (EN)",
        "ashley-ja": "Ashley (JA)",
        "amy": "Amy",
    }


def test_single_voice_keeps_bare_name() -> None:
    assert resolve_display_names([("ashley-en", "en")], {}) == {"ashley-en": "Ashley"}


def test_override_wins_and_leaves_siblings_unambiguous() -> None:
    voices = [("ashley-en", "en"), ("ashley-ja", "ja")]
    assert resolve_display_names(voices, {"ashley-en": "Ash"}) == {
        "ashley-en": "Ash",
        "ashley-ja": "Ashley",
    }


async def test_voices_list_carries_display_name(vclient: httpx.AsyncClient) -> None:
    response = await vclient.get("/api/v1/voices")
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()["items"]}
    assert by_id["ashley-en"]["display_name"] == "Ashley (EN)"
    assert by_id["ashley-kr"]["display_name"] == "Ashley (KO)"


async def test_voice_names_get_shape(vclient: httpx.AsyncClient) -> None:
    response = await vclient.get("/api/v1/admin/voice-names")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["names"] == {}
    assert body["items"] == [
        {"id": "ashley-zh", "display_name": "Ashley (ZH)", "overridden": False},
        {"id": "ashley-ja", "display_name": "Ashley (JA)", "overridden": False},
        {"id": "ashley-kr", "display_name": "Ashley (KO)", "overridden": False},
        {"id": "ashley-en", "display_name": "Ashley (EN)", "overridden": False},
    ]


async def test_put_saves_override_and_it_wins_everywhere(vclient: httpx.AsyncClient) -> None:
    response = await vclient.put(
        "/api/v1/admin/voice-names", json={"names": {"ashley-en": "  Ash  "}}, headers=csrf(vclient)
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"names": {"ashley-en": "Ash"}}

    body = (await vclient.get("/api/v1/admin/voice-names")).json()
    assert body["names"] == {"ashley-en": "Ash"}
    en = next(item for item in body["items"] if item["id"] == "ashley-en")
    assert en == {"id": "ashley-en", "display_name": "Ash", "overridden": True}
    # zh/ja/kr still collide with each other, so ja keeps its language suffix.
    ja = next(item for item in body["items"] if item["id"] == "ashley-ja")
    assert ja["display_name"] == "Ashley (JA)"

    items = (await vclient.get("/api/v1/voices?refresh=true")).json()["items"]
    assert next(item for item in items if item["id"] == "ashley-en")["display_name"] == "Ash"


async def test_put_empty_value_removes_override(vclient: httpx.AsyncClient) -> None:
    await vclient.put(
        "/api/v1/admin/voice-names", json={"names": {"ashley-en": "Ash"}}, headers=csrf(vclient)
    )
    response = await vclient.put(
        "/api/v1/admin/voice-names", json={"names": {"ashley-en": "   "}}, headers=csrf(vclient)
    )
    assert response.status_code == 200 and response.json() == {"names": {}}
    body = (await vclient.get("/api/v1/admin/voice-names")).json()
    assert body["names"] == {}
    assert all(not item["overridden"] for item in body["items"])


async def test_put_rejects_unknown_voice_and_long_names(vclient: httpx.AsyncClient) -> None:
    response = await vclient.put(
        "/api/v1/admin/voice-names", json={"names": {"ghost-en": "Boo"}}, headers=csrf(vclient)
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_failed"
    response = await vclient.put(
        "/api/v1/admin/voice-names",
        json={"names": {"ashley-en": "x" * 41}},
        headers=csrf(vclient),
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_failed"
    assert (await vclient.get("/api/v1/admin/voice-names")).json()["names"] == {}


async def test_put_requires_csrf(vclient: httpx.AsyncClient) -> None:
    response = await vclient.put("/api/v1/admin/voice-names", json={"names": {}})
    assert response.status_code == 403 and response.json()["error"]["code"] == "csrf_failed"


async def test_voice_names_endpoints_require_admin(uclient: httpx.AsyncClient) -> None:
    assert (await uclient.get("/api/v1/admin/voice-names")).status_code == 403
    response = await uclient.put(
        "/api/v1/admin/voice-names", json={"names": {"ashley-en": "Ash"}}, headers=csrf(uclient)
    )
    assert response.status_code == 403 and response.json()["error"]["code"] == "forbidden"
