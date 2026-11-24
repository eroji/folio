"""Admin → Voices → TTS server: the admin URL/key/concurrency over the env
defaults, the admin API, and every TTS path using the effective values."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from mock_tts import REQUESTS, SILENT_OPUS
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.integrations import (
    Integrations,
    TtsServer,
    apply_tts,
    effective_tts_settings,
    load_integrations,
    save_integrations,
)
from folio.models import Audio, Book, Chapter, Segment
from folio.routers import admin as admin_module
from folio.tts import client as client_module
from folio.tts.cache import speech_cache_key
from folio.tts.narration import engine_instructions
from folio.tts.queue import claim_next_tts, prepare, run_tts_job
from folio.tts.text import normalize_speech_text
from folio.tts.voices import reset_voice_cache

URL = "/api/v1/admin/integrations"
ENV_URL = "http://127.0.0.1:9/v1"  # nothing listens: refused at once


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


@pytest.fixture(autouse=True)
def _fresh_voice_cache() -> None:
    reset_voice_cache()


@pytest.fixture()
def env(settings: Settings) -> Settings:
    """The server's environment: its own URL, a secret key, 4 at a time."""
    return settings.model_copy(
        update={"tts_base_url": ENV_URL, "tts_api_key": "env-secret", "tts_concurrency": 4}
    )


def _save_tts(db: Session, **fields: Any) -> None:
    save_integrations(db, Integrations(tts=TtsServer(**fields)))
    db.commit()


# --- the effective-value rule -------------------------------------------------


def test_no_admin_server_uses_the_env_url_key_and_concurrency(env: Settings) -> None:
    out = apply_tts(TtsServer(), env)
    assert (out.tts_base_url, out.tts_api_key, out.tts_concurrency) == (ENV_URL, "env-secret", 4)


def test_admin_url_wins_and_never_carries_the_env_key(env: Settings) -> None:
    out = apply_tts(TtsServer(base_url="http://vllm.test:8880/v1"), env)
    assert out.tts_base_url == "http://vllm.test:8880/v1"
    assert out.tts_api_key == ""  # the env key never goes to an admin-entered server
    keyed = apply_tts(TtsServer(base_url="http://vllm.test:8880/v1", api_key="admin-key"), env)
    assert keyed.tts_api_key == "admin-key"


def test_an_admin_key_without_an_admin_url_is_not_used(env: Settings) -> None:
    out = apply_tts(TtsServer(api_key="admin-key"), env)
    assert (out.tts_base_url, out.tts_api_key) == (ENV_URL, "env-secret")


def test_admin_concurrency_wins_and_none_falls_back(env: Settings) -> None:
    assert apply_tts(TtsServer(concurrency=1), env).tts_concurrency == 1
    assert apply_tts(TtsServer(concurrency=None), env).tts_concurrency == 4
    # Concurrency alone keeps the env server and key.
    alone = apply_tts(TtsServer(concurrency=2), env)
    assert (alone.tts_base_url, alone.tts_api_key) == (ENV_URL, "env-secret")


def test_admin_model_wins_over_the_env_whichever_server_is_in_effect(env: Settings) -> None:
    # No admin URL: the env server with the admin's model.
    out = apply_tts(TtsServer(model="s2-pro"), env)
    assert out.tts_model == "s2-pro"
    assert (out.tts_base_url, out.tts_api_key) == (ENV_URL, "env-secret")
    # With an admin URL too.
    admin = apply_tts(TtsServer(base_url="http://vllm.test:8880/v1", model="s2-pro"), env)
    assert (admin.tts_base_url, admin.tts_api_key, admin.tts_model) == (
        "http://vllm.test:8880/v1",
        "",
        "s2-pro",
    )
    # Empty: TTS_MODEL stands.
    assert apply_tts(TtsServer(), env).tts_model == env.tts_model


def test_the_code_default_is_one_request_per_segment() -> None:
    assert Settings.model_fields["tts_request_chars"].default == 0


@pytest.mark.parametrize(
    ("admin", "env_chars", "expected"),
    [
        (None, 0, 0),  # unset: the env
        (None, 300, 300),
        (True, 0, 400),  # one sentence each: the env length when set, else 400
        (True, 300, 300),
        (False, 0, 0),  # whole segment
        (False, 300, 0),
    ],
)
def test_request_choice_precedence(
    env: Settings, admin: bool | None, env_chars: int, expected: int
) -> None:
    base = env.model_copy(update={"tts_request_chars": env_chars})
    out = apply_tts(TtsServer(sentence_requests=admin), base)
    assert out.tts_request_chars == expected
    assert (out.tts_base_url, out.tts_api_key) == (ENV_URL, "env-secret")


def test_effective_settings_read_the_saved_block(db: Session, env: Settings) -> None:
    assert effective_tts_settings(db, env).tts_base_url == ENV_URL
    _save_tts(db, base_url="http://vllm.test:8880/v1", api_key="k", concurrency=2)
    out = effective_tts_settings(db, env)
    assert (out.tts_base_url, out.tts_api_key, out.tts_concurrency) == (
        "http://vllm.test:8880/v1",
        "k",
        2,
    )
    assert env.tts_base_url == ENV_URL  # the cached env settings are never changed


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, TtsServer()),
        ("junk", TtsServer()),
        ({"tts": "junk"}, TtsServer()),
        (
            {"tts": {"base_url": " http://a/v1 ", "api_key": "k", "concurrency": 3}},
            TtsServer(base_url="http://a/v1", api_key="k", concurrency=3),
        ),
        ({"tts": {"concurrency": 0}}, TtsServer()),
        ({"tts": {"concurrency": 17}}, TtsServer()),
        ({"tts": {"concurrency": "2"}}, TtsServer()),
        ({"tts": {"concurrency": True}}, TtsServer()),
        ({"tts": {"base_url": 5, "api_key": None}}, TtsServer()),
        ({"tts": {"sentence_requests": False}}, TtsServer(sentence_requests=False)),
        ({"tts": {"sentence_requests": "yes"}}, TtsServer()),
        ({"tts": {"model": " s2-pro "}}, TtsServer(model="s2-pro")),
        ({"tts": {"model": 5}}, TtsServer()),
    ],
)
def test_parsing_is_defensive(db: Session, raw: Any, expected: TtsServer) -> None:
    from folio.integrations import KEY
    from folio.models import AppSetting

    db.add(AppSetting(key=KEY, value=raw))
    db.commit()
    assert load_integrations(db).tts == expected


# --- the admin API --------------------------------------------------------------


async def test_get_shows_the_env_fallback_and_masks_the_key(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    shown = (await admin_client.get(URL)).json()["tts"]
    assert shown == {
        "base_url": "",
        "env_base_url": settings.tts_base_url or "",
        "model": "",
        "env_model": settings.tts_model,
        "key_set": False,
        "key_hint": None,
        "concurrency": None,
        "env_concurrency": settings.tts_concurrency,
        "sentence_requests": None,
        "env_request_chars": settings.tts_request_chars,
        "source": "env" if settings.tts_base_url else "none",
    }
    _save_tts(db, base_url="http://vllm.test:8880/v1", api_key="sk-secret-tts-9876", concurrency=2)
    response = await admin_client.get(URL)
    shown = response.json()["tts"]
    assert shown["base_url"] == "http://vllm.test:8880/v1"
    assert (shown["key_set"], shown["key_hint"], shown["concurrency"]) == (True, "…9876", 2)
    assert shown["source"] == "admin"
    assert "sk-secret" not in response.text


async def test_put_keeps_omitted_fields_and_clears_back_to_env(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    body = {
        "tts": {"base_url": " http://vllm.test:8880/v1 ", "api_key": "k-1234", "concurrency": 2}
    }
    response = await admin_client.put(URL, json=body, headers=csrf(admin_client))
    assert response.status_code == 200, response.text
    assert load_integrations(db).tts == TtsServer("http://vllm.test:8880/v1", "k-1234", 2)

    # Left out = kept; the other integrations are untouched.
    await admin_client.put(
        URL,
        json={"tts": {"concurrency": 1}, "google_books_api_key": "g"},
        headers=csrf(admin_client),
    )
    db.expire_all()
    saved = load_integrations(db)
    assert saved.tts == TtsServer("http://vllm.test:8880/v1", "k-1234", 1)
    assert saved.google_books_api_key == "g"

    # A PUT without the tts block keeps it (the AI page saves its own block).
    await admin_client.put(URL, json={"language_model": {"model": "m"}}, headers=csrf(admin_client))
    db.expire_all()
    assert load_integrations(db).tts == TtsServer("http://vllm.test:8880/v1", "k-1234", 1)

    await admin_client.put(
        URL, json={"tts": {"sentence_requests": True}}, headers=csrf(admin_client)
    )
    db.expire_all()
    assert load_integrations(db).tts.sentence_requests is True
    assert load_integrations(db).tts.concurrency == 1

    # Empty URL and null concurrency/requests go back to the env; null key removes it.
    response = await admin_client.put(
        URL,
        json={
            "tts": {"base_url": "", "api_key": None, "concurrency": None, "sentence_requests": None}
        },
        headers=csrf(admin_client),
    )
    db.expire_all()
    assert load_integrations(db).tts == TtsServer()
    assert response.json()["tts"]["source"] in ("env", "none")


async def test_a_new_url_never_inherits_the_old_servers_key(
    admin_client: httpx.AsyncClient, db: Session, mock_tts: str
) -> None:
    """A key belongs to the server it was entered for: moving to another URL (or back to
    the env) without a key in the same save drops it, so it is never sent elsewhere."""
    _save_tts(db, base_url="http://old.test:8880/v1", api_key="old-server-key")

    # Same URL re-sent (the pane always sends it): the key stays.
    await admin_client.put(
        URL, json={"tts": {"base_url": "http://old.test:8880/v1"}}, headers=csrf(admin_client)
    )
    db.expire_all()
    assert load_integrations(db).tts.api_key == "old-server-key"

    # A draft test against another URL is not sent the saved key.
    await admin_client.post(
        f"{URL}/tts/test", json={"base_url": f"{mock_tts}/v1"}, headers=csrf(admin_client)
    )
    assert mock_tts_requests()[-1][2] is None

    # A new URL without a key: the old key is dropped.
    await admin_client.put(
        URL, json={"tts": {"base_url": "http://new.test:8880/v1"}}, headers=csrf(admin_client)
    )
    db.expire_all()
    assert load_integrations(db).tts == TtsServer("http://new.test:8880/v1", "")

    # A new URL with its own key in the same save keeps that key.
    await admin_client.put(
        URL,
        json={"tts": {"base_url": "http://third.test/v1", "api_key": "third-key"}},
        headers=csrf(admin_client),
    )
    db.expire_all()
    assert load_integrations(db).tts == TtsServer("http://third.test/v1", "third-key")

    # Back to the env: the admin key goes too.
    await admin_client.put(URL, json={"tts": {"base_url": ""}}, headers=csrf(admin_client))
    db.expire_all()
    assert load_integrations(db).tts.api_key == ""


@pytest.mark.parametrize(
    "tts",
    [
        {"base_url": "vllm.test:8880/v1"},
        {"base_url": "ftp://vllm.test/v1"},
        {"concurrency": 0},
        {"concurrency": 17},
        {"concurrency": "many"},
        {"concurrency": 2.5},
    ],
)
async def test_put_rejects_a_bad_url_or_concurrency(
    admin_client: httpx.AsyncClient, db: Session, tts: dict[str, Any]
) -> None:
    response = await admin_client.put(URL, json={"tts": tts}, headers=csrf(admin_client))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    assert load_integrations(db).tts == TtsServer()


async def test_put_accepts_the_concurrency_bounds(admin_client: httpx.AsyncClient) -> None:
    for value in (1, 16):
        response = await admin_client.put(
            URL, json={"tts": {"concurrency": value}}, headers=csrf(admin_client)
        )
        assert response.json()["tts"]["concurrency"] == value


async def test_put_saves_the_model_and_get_shows_both(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    response = await admin_client.put(
        URL, json={"tts": {"model": "s2-pro"}}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    shown = response.json()["tts"]
    assert (shown["model"], shown["env_model"]) == ("s2-pro", settings.tts_model)
    assert load_integrations(db).tts.model == "s2-pro"

    # Trimmed, and another block of the form never touches it.
    await admin_client.put(URL, json={"tts": {"model": "  s2-max  "}}, headers=csrf(admin_client))
    db.expire_all()
    assert load_integrations(db).tts.model == "s2-max"
    await admin_client.put(
        URL, json={"language_model": {"model": "llm"}}, headers=csrf(admin_client)
    )
    db.expire_all()
    assert load_integrations(db).tts.model == "s2-max"

    # A field left out keeps the saved value; the other TTS fields still work.
    shown = (
        await admin_client.put(URL, json={"tts": {"concurrency": 2}}, headers=csrf(admin_client))
    ).json()["tts"]
    assert (shown["model"], shown["env_model"]) == ("s2-max", settings.tts_model)


async def test_an_empty_model_clears_back_to_the_env_model(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    await admin_client.put(URL, json={"tts": {"model": "s2-pro"}}, headers=csrf(admin_client))
    assert effective_tts_settings(db, settings).tts_model == "s2-pro"

    response = await admin_client.put(URL, json={"tts": {"model": ""}}, headers=csrf(admin_client))
    assert response.json()["tts"]["model"] == ""
    db.expire_all()
    assert load_integrations(db).tts.model == ""
    assert effective_tts_settings(db, settings).tts_model == settings.tts_model


async def test_state_changes_need_csrf_and_an_admin(
    admin_client: httpx.AsyncClient, auth_client: httpx.AsyncClient
) -> None:
    body = {"tts": {"base_url": "http://x/v1"}}
    assert (await admin_client.put(URL, json=body)).status_code == 403
    assert (await admin_client.post(f"{URL}/tts/test", json={})).status_code == 403


async def test_users_cannot_see_or_test_it(auth_client: httpx.AsyncClient) -> None:
    assert (await auth_client.get(URL)).status_code == 403
    response = await auth_client.post(f"{URL}/tts/test", json={}, headers=csrf(auth_client))
    assert response.status_code == 403


async def test_test_reaches_a_draft_server(
    admin_client: httpx.AsyncClient, db: Session, mock_tts: str
) -> None:
    response = await admin_client.post(
        f"{URL}/tts/test",
        json={"base_url": f"{mock_tts}/v1", "api_key": "draft-key"},
        headers=csrf(admin_client),
    )
    result = response.json()
    assert result["ok"] is True, result
    assert result["voices"] == 1 and isinstance(result["latency_ms"], int)
    assert "1 voice" in result["message"]
    assert ("GET", "/v1/audio/voices", "Bearer draft-key") in mock_tts_requests()
    assert load_integrations(db).tts == TtsServer()  # a test never saves


async def test_test_falls_back_to_the_saved_server_and_key(
    admin_client: httpx.AsyncClient, db: Session, mock_tts: str
) -> None:
    _save_tts(db, base_url=f"{mock_tts}/v1", api_key="saved-key")
    result = (
        await admin_client.post(f"{URL}/tts/test", json={}, headers=csrf(admin_client))
    ).json()
    assert result["ok"] is True
    assert mock_tts_requests()[-1][2] == "Bearer saved-key"


async def test_test_reports_failure_without_raising(admin_client: httpx.AsyncClient) -> None:
    response = await admin_client.post(
        f"{URL}/tts/test", json={"base_url": "http://127.0.0.1:9/v1"}, headers=csrf(admin_client)
    )
    assert response.status_code == 200
    result = response.json()
    assert result["ok"] is False and result["message"]
    bad = await admin_client.post(
        f"{URL}/tts/test", json={"base_url": "nope"}, headers=csrf(admin_client)
    )
    assert bad.status_code == 422


def mock_tts_requests() -> list[tuple[str, str, str | None]]:
    return list(REQUESTS)


# --- every TTS path uses the effective server ----------------------------------


def _one_segment_book(db: Session) -> tuple[Book, Segment]:
    book = Book(title="Server Book", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=10)
    db.add(chapter)
    db.flush()
    segment = Segment(
        chapter_id=chapter.id, idx=0, text="Hello from the server.", char_start=0, char_end=10
    )
    db.add(segment)
    db.commit()
    return book, segment


def test_worker_synthesizes_on_the_admin_server_with_the_admin_key(
    db: Session, env: Settings, mock_tts: str
) -> None:
    _save_tts(db, base_url=f"{mock_tts}/v1")
    book, segment = _one_segment_book(db)
    prepare(db, env, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None

    run_tts_job(db, env, row)  # env still names its own server: the DB wins

    assert row.status == "ready", row.error
    speech = [r for r in mock_tts_requests() if r[1] == "/v1/audio/speech"]
    assert speech and all(auth is None for _m, _p, auth in speech)  # env key never sent
    # The clip is keyed by the admin endpoint, so switching servers re-makes audio.
    admin = env.model_copy(update={"tts_base_url": f"{mock_tts}/v1"})
    prompt = engine_instructions(db, env, "ashley-en", book.genre, book.delivery_note)
    text = normalize_speech_text(segment.text)
    key = speech_cache_key(admin, "ashley-en", text, prompt, "en")
    assert row.cache_key == key
    assert key != speech_cache_key(env, "ashley-en", text, prompt, "en")


def test_worker_picks_up_a_change_on_its_next_job(
    db: Session, env: Settings, mock_tts: str
) -> None:
    book, segment = _one_segment_book(db)
    prepare(db, env, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    run_tts_job(db, env, row)  # the env server does not exist
    assert row.status == "failed"

    _save_tts(db, base_url=f"{mock_tts}/v1", api_key="admin-key")
    row.status = "queued"
    db.commit()
    again = claim_next_tts(db)
    assert again is not None
    run_tts_job(db, env, again)  # same Settings object: no restart
    assert again.status == "ready", again.error
    assert mock_tts_requests()[-1] == ("POST", "/v1/audio/speech", "Bearer admin-key")


def test_prepare_finds_clips_under_the_admin_endpoint(
    db: Session, env: Settings, mock_tts: str
) -> None:
    _save_tts(db, base_url=f"{mock_tts}/v1")
    book, segment = _one_segment_book(db)
    admin = env.model_copy(update={"tts_base_url": f"{mock_tts}/v1", "tts_api_key": ""})
    prompt = engine_instructions(db, env, "ashley-en", book.genre, book.delivery_note)
    key = speech_cache_key(admin, "ashley-en", normalize_speech_text(segment.text), prompt, "en")
    path = Path(env.data_dir) / "audio" / key[:2] / f"{key}.opus"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(SILENT_OPUS)
    db.add(Audio(cache_key=key, path=str(path), format="opus", voice="ashley-en", model="tts"))
    db.commit()

    window = prepare(db, env, book, segment.id, count=0, voice="ashley-en")

    assert [(r.status, r.cache_key) for _s, r in window] == [("ready", key)]


def test_the_client_uses_the_admin_concurrency(
    db: Session, env: Settings, mock_tts: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    counts: list[int] = []
    real = client_module._slots

    def spy(count: int) -> Any:
        counts.append(count)
        return real(count)

    monkeypatch.setattr(client_module, "_slots", spy)
    _save_tts(db, base_url=f"{mock_tts}/v1", concurrency=1)
    book, segment = _one_segment_book(db)
    prepare(db, env, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    run_tts_job(db, env, row)
    assert row.status == "ready" and counts and set(counts) == {1}  # env says 4


async def test_voice_discovery_lists_the_admin_server(
    admin_client: httpx.AsyncClient, db: Session, mock_tts: str
) -> None:
    _save_tts(db, base_url=f"{mock_tts}/v1", api_key="admin-key")
    body = (await admin_client.get("/api/v1/voices?refresh=true")).json()
    on_server = [v["id"] for v in body["items"] if v.get("on_server")]
    assert "ashley-en" in on_server
    assert ("GET", "/v1/audio/voices", "Bearer admin-key") in mock_tts_requests()


async def test_saving_a_server_drops_the_cached_voice_list(
    admin_client: httpx.AsyncClient, db: Session, mock_tts: str
) -> None:
    await admin_client.get("/api/v1/voices")  # caches the (unreachable) env server's list
    await admin_client.put(
        URL, json={"tts": {"base_url": f"{mock_tts}/v1"}}, headers=csrf(admin_client)
    )
    body = (await admin_client.get("/api/v1/voices")).json()
    assert any(v["id"] == "ashley-en" and v.get("on_server") for v in body["items"])


async def test_admin_health_probes_the_admin_server(
    admin_client: httpx.AsyncClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _save_tts(db, base_url="http://vllm.test:8880/v1")
    seen: list[str] = []

    def fake_get(url: str, **kwargs: Any) -> httpx.Response:
        seen.append(url)
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(admin_module.httpx, "get", fake_get)
    assert (await admin_client.get("/api/v1/admin/health")).json()["tts"] == "ok"
    assert (await admin_client.get("/api/v1/admin/cache")).json()["tts"]["status"] == "ok"
    assert seen == ["http://vllm.test:8880/health"] * 2


@pytest.mark.parametrize(("sentences", "requests"), [(False, 1), (True, 3)])
def test_synthesis_follows_the_admin_request_choice(
    db: Session, env: Settings, mock_tts: str, sentences: bool, requests: int
) -> None:
    _save_tts(db, base_url=f"{mock_tts}/v1", sentence_requests=sentences)
    split_by_env = env.model_copy(update={"tts_request_chars": 400})  # env says sentences
    if not sentences:
        env = split_by_env  # whole segment wins over the env too
    book, segment = _one_segment_book(db)
    segment.text = (
        "The first sentence walks slowly along the harbour wall. "
        "The second sentence watches the boats come in at dusk. "
        "The third sentence goes home to a warm and quiet house."
    )
    db.commit()
    prepare(db, env, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    run_tts_job(db, env, row)
    assert row.status == "ready", row.error
    speech = [r for r in mock_tts_requests() if r[1] == "/v1/audio/speech"]
    assert len(speech) == requests
    audio = db.get(Audio, row.cache_key)
    assert audio is not None
    assert (audio.marks is None) is (not sentences)  # read-along marks only when split


def test_synthesis_sends_the_admin_model_and_no_seed(
    db: Session, env: Settings, mock_tts: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    bodies: list[dict[str, Any]] = []
    real_post = httpx.Client.post

    def spy(self: Any, url: str, **kwargs: Any) -> Any:
        body = kwargs.get("json")
        if url.endswith("/audio/speech") and isinstance(body, dict):
            bodies.append(body)
        return real_post(self, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "post", spy)
    _save_tts(db, base_url=f"{mock_tts}/v1", model="s2-pro")
    book, segment = _one_segment_book(db)
    prepare(db, env, book, segment.id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None
    run_tts_job(db, env, row)

    assert row.status == "ready", row.error
    assert bodies and all(body["model"] == "s2-pro" for body in bodies)
    assert all("seed" not in body for body in bodies)
    # The clip is keyed by the model that made it.
    keyed = env.model_copy(update={"tts_base_url": f"{mock_tts}/v1", "tts_model": "s2-pro"})
    prompt = engine_instructions(db, env, "ashley-en", book.genre, book.delivery_note)
    assert row.cache_key == speech_cache_key(
        keyed, "ashley-en", normalize_speech_text(segment.text), prompt, "en"
    )
