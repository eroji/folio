"""Admin voice catalog API: PATCH alias/override, PUT defaults, DELETE removed entries."""

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

ENGINE_VOICES = {
    "voices": ["tts", "ashley-zh", "ashley-ja", "ashley-kr", "ashley-en", "bruno-en", "mystery"]
}

Handler = Callable[[httpx.Request], httpx.Response]


class _Handlers:
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


def _app(handler: Handler) -> FastAPI:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        tts_base_url=f"http://admin-voices-{uuid.uuid4().hex[:8]}.test/v1",
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
    return app


async def _login(app: FastAPI, username: str, role: str) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://testserver"
    ) as client:
        await client.post("/api/v1/test/login", json={"username": username, "role": role})
        yield client


@pytest.fixture()
async def aclient(db: Session, tts_handler: _Handlers) -> AsyncIterator[httpx.AsyncClient]:
    async for client in _login(_app(tts_handler.dispatch), "testadmin", "admin"):
        yield client


@pytest.fixture()
async def uclient(db: Session, tts_handler: _Handlers) -> AsyncIterator[httpx.AsyncClient]:
    async for client in _login(_app(tts_handler.dispatch), "testuser", "user"):
        yield client


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def item_of(body: dict[str, Any], voice_id: str) -> dict[str, Any]:
    return next(item for item in body["items"] if item["id"] == voice_id)


async def test_patch_display_name_saves_and_returns_item(aclient: httpx.AsyncClient) -> None:
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en", json={"display_name": "  Ash  "}, headers=csrf(aclient)
    )
    assert response.status_code == 200, response.text
    assert response.json()["display_name"] == "Ash"
    body = (await aclient.get("/api/v1/voices")).json()
    assert item_of(body, "ashley-en")["display_name"] == "Ash"
    # An empty name clears the alias back to the derived default.
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en", json={"display_name": ""}, headers=csrf(aclient)
    )
    assert response.json()["display_name"] == "Ashley"


async def test_patch_language_override_assigns_and_unassigns(aclient: httpx.AsyncClient) -> None:
    # "mystery" cannot be detected: unassigned, never a default, hidden from groups.
    body = (await aclient.get("/api/v1/voices")).json()
    assert item_of(body, "mystery") == {
        "id": "mystery",
        "display_name": "Mystery",
        "language": None,
        "is_default": False,
        "books_count": 0,
        "on_server": True,
        "language_overridden": False,
        "instructions": "",
    }
    response = await aclient.patch(
        "/api/v1/admin/voices/mystery", json={"language_override": "ja"}, headers=csrf(aclient)
    )
    assert response.status_code == 200
    item = response.json()
    assert item["language"] == "ja" and item["language_overridden"] is True
    # ashley-ja keeps the automatic ja default; assigning does not steal it.
    body = (await aclient.get("/api/v1/voices")).json()
    assert body["defaults"]["ja"] == "ashley-ja"
    assert item_of(body, "mystery")["is_default"] is False
    # Unassign (null = detect again): back to unassigned, alias kept.
    await aclient.patch(
        "/api/v1/admin/voices/mystery", json={"display_name": "Mys"}, headers=csrf(aclient)
    )
    response = await aclient.patch(
        "/api/v1/admin/voices/mystery", json={"language_override": None}, headers=csrf(aclient)
    )
    assert response.json()["language"] is None
    assert response.json()["language_overridden"] is False
    assert response.json()["display_name"] == "Mys"


async def test_patch_rejects_unknown_voice_bad_name_and_bad_language(
    aclient: httpx.AsyncClient,
) -> None:
    response = await aclient.patch(
        "/api/v1/admin/voices/ghost-en", json={"display_name": "Boo"}, headers=csrf(aclient)
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_failed"
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en", json={"display_name": "x" * 41}, headers=csrf(aclient)
    )
    assert response.status_code == 422
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en", json={"language_override": "de"}, headers=csrf(aclient)
    )
    assert response.status_code == 422
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en", json={"nonsense": 1}, headers=csrf(aclient)
    )
    assert response.status_code == 422


async def test_patch_and_defaults_require_csrf(aclient: httpx.AsyncClient) -> None:
    assert (
        await aclient.patch("/api/v1/admin/voices/ashley-en", json={"display_name": "Ash"})
    ).status_code == 403  # no CSRF header
    assert (
        await aclient.put(
            "/api/v1/admin/voices/defaults", json={"language": "en", "voice_id": "bruno-en"}
        )
    ).status_code == 403


async def test_user_endpoints_forbidden(uclient: httpx.AsyncClient) -> None:
    assert (
        await uclient.patch(
            "/api/v1/admin/voices/ashley-en", json={"display_name": "Ash"}, headers=csrf(uclient)
        )
    ).status_code == 403
    assert (
        await uclient.put(
            "/api/v1/admin/voices/defaults",
            json={"language": "en", "voice_id": "bruno-en"},
            headers=csrf(uclient),
        )
    ).status_code == 403
    assert (
        await uclient.delete("/api/v1/admin/voices/ashley-en", headers=csrf(uclient))
    ).status_code == 403


async def test_put_defaults_sets_and_validates(aclient: httpx.AsyncClient) -> None:
    response = await aclient.put(
        "/api/v1/admin/voices/defaults",
        json={"language": "en", "voice_id": "bruno-en"},
        headers=csrf(aclient),
    )
    assert response.status_code == 200, response.text
    assert response.json()["defaults"] == {
        "en": "bruno-en",
        "ja": "ashley-ja",
        "ko": "ashley-kr",
        "zh": "ashley-zh",
    }
    body = (await aclient.get("/api/v1/voices")).json()
    assert item_of(body, "bruno-en")["is_default"] is True
    assert item_of(body, "ashley-en")["is_default"] is False
    # Wrong language, off-server voice, the tts entry and unknown languages are rejected.
    for bad in (
        {"language": "ja", "voice_id": "bruno-en"},
        {"language": "en", "voice_id": "ghost-en"},
        {"language": "en", "voice_id": "tts"},
        {"language": "de", "voice_id": "bruno-en"},
    ):
        response = await aclient.put(
            "/api/v1/admin/voices/defaults", json=bad, headers=csrf(aclient)
        )
        assert response.status_code == 422, bad
    assert (await aclient.get("/api/v1/voices")).json()["defaults"]["en"] == "bruno-en"


async def test_explicit_default_falls_back_when_the_voice_is_removed(
    aclient: httpx.AsyncClient, tts_handler: _Handlers
) -> None:
    await aclient.put(
        "/api/v1/admin/voices/defaults",
        json={"language": "en", "voice_id": "bruno-en"},
        headers=csrf(aclient),
    )
    shrunk = {"voices": [v for v in ENGINE_VOICES["voices"] if v != "bruno-en"]}
    tts_handler.fn = lambda _request: httpx.Response(200, json=shrunk)
    body = (await aclient.get("/api/v1/voices?refresh=true")).json()
    assert body["defaults"]["en"] == "ashley-en"  # next on-server en voice
    assert item_of(body, "ashley-en")["is_default"] is True
    assert item_of(body, "bruno-en")["on_server"] is False


async def test_delete_removes_all_entries_for_a_voice(
    aclient: httpx.AsyncClient, tts_handler: _Handlers
) -> None:
    await aclient.patch(
        "/api/v1/admin/voices/bruno-en", json={"display_name": "Bruno"}, headers=csrf(aclient)
    )
    await aclient.patch(
        "/api/v1/admin/voices/bruno-en",
        json={"instructions": "Warm tone."},
        headers=csrf(aclient),
    )
    await aclient.put(
        "/api/v1/admin/voices/defaults",
        json={"language": "en", "voice_id": "bruno-en"},
        headers=csrf(aclient),
    )
    shrunk = {"voices": [v for v in ENGINE_VOICES["voices"] if v != "bruno-en"]}
    tts_handler.fn = lambda _request: httpx.Response(200, json=shrunk)
    response = await aclient.delete("/api/v1/admin/voices/bruno-en", headers=csrf(aclient))
    assert response.status_code == 204
    body = (await aclient.get("/api/v1/voices?refresh=true")).json()
    assert "bruno-en" not in [item["id"] for item in body["items"]]  # alias and default gone
    assert body["defaults"]["en"] == "ashley-en"
    response = await aclient.patch(
        "/api/v1/admin/voices/bruno-en", json={"instructions": "x"}, headers=csrf(aclient)
    )
    assert response.status_code == 422  # the instruction entry went with the voice
    # Deleting an on-server voice only clears its metadata; the voice stays listed.
    await aclient.patch(
        "/api/v1/admin/voices/mystery", json={"language_override": "ja"}, headers=csrf(aclient)
    )
    await aclient.delete("/api/v1/admin/voices/mystery", headers=csrf(aclient))
    mystery = item_of((await aclient.get("/api/v1/voices")).json(), "mystery")
    assert mystery["language"] is None and mystery["language_overridden"] is False


async def test_delete_requires_csrf(aclient: httpx.AsyncClient) -> None:
    assert (await aclient.delete("/api/v1/admin/voices/ashley-en")).status_code == 403


async def test_patch_instructions_saves_and_clears_per_voice(
    aclient: httpx.AsyncClient,
) -> None:
    item = item_of((await aclient.get("/api/v1/voices")).json(), "ashley-en")
    assert item["instructions"] == ""
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en",
        json={"instructions": "  Warm, expressive  "},
        headers=csrf(aclient),
    )
    assert response.status_code == 200, response.text
    assert response.json()["instructions"] == "Warm, expressive"
    body = (await aclient.get("/api/v1/voices")).json()
    assert item_of(body, "ashley-en")["instructions"] == "Warm, expressive"
    assert item_of(body, "bruno-en")["instructions"] == ""  # per voice, not global
    for clear in (None, ""):  # null and empty both clear
        response = await aclient.patch(
            "/api/v1/admin/voices/ashley-en",
            json={"instructions": clear},
            headers=csrf(aclient),
        )
        assert response.json()["instructions"] == ""


async def test_patch_instructions_length_and_csrf(aclient: httpx.AsyncClient) -> None:
    response = await aclient.patch(
        "/api/v1/admin/voices/ashley-en",
        json={"instructions": "x" * 501},
        headers=csrf(aclient),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    assert (
        await aclient.patch("/api/v1/admin/voices/ashley-en", json={"instructions": "x"})
    ).status_code == 403  # no CSRF header


async def test_patch_instructions_forbidden_for_users(uclient: httpx.AsyncClient) -> None:
    assert (
        await uclient.patch(
            "/api/v1/admin/voices/ashley-en",
            json={"instructions": "x"},
            headers=csrf(uclient),
        )
    ).status_code == 403
