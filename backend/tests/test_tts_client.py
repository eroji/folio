"""TtsClient: pinned request body, bearer auth, retry/backoff, opus->mp3, discovery."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from folio.config import Settings
from folio.tts import TtsClient, TtsError


def _settings(**over: Any) -> Settings:
    base: dict[str, Any] = {
        "tts_base_url": "http://tts.test/v1",
        "tts_model": "tts",
        "tts_format": "opus",
        "tts_default_voice": "ashley-en",
    }
    base.update(over)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


def _client(handler: Any, **over: Any) -> TtsClient:
    client = TtsClient(_settings(**over))
    # Swap in a MockTransport but keep the headers TtsClient built (bearer token).
    client._client = httpx.Client(
        transport=httpx.MockTransport(handler), timeout=60, headers=client._client.headers
    )
    return client


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("folio.tts.client.time.sleep", lambda _s: None)


def test_synthesize_posts_the_pinned_body() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"OggS-data", headers={"content-type": "audio/ogg"})

    data, fmt = _client(handler).synthesize("Hello there", "ashley-en")
    assert (data, fmt) == (b"OggS-data", "opus")
    assert captured["path"] == "/v1/audio/speech"
    assert captured["body"] == {
        "model": "tts",
        "voice": "ashley-en",
        "input": "Hello there",
        "response_format": "opus",
        "speed": 1.0,
    }


def test_instructions_in_body_only_when_set() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=b"x")

    client = _client(handler)
    client.synthesize("hi", "v", "Warm tone.")
    client.synthesize("hi", "v")
    client.synthesize("hi", "v", "")
    client.synthesize("hi", "v", None)
    assert [body.get("instructions") for body in seen] == ["Warm tone.", None, None, None]


def test_bearer_header_sent_only_when_api_key() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, content=b"x")

    _client(handler).synthesize("hi", "v")
    assert seen == [None]
    _client(handler, tts_api_key="sekret").synthesize("hi", "v")
    assert seen == [None, "Bearer sekret"]


def test_retry_then_success() -> None:
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500) if calls["n"] == 1 else httpx.Response(200, content=b"ok")

    data, _ = _client(handler).synthesize("hi", "v")
    assert data == b"ok"
    assert calls["n"] == 2  # one retry, then success


def test_four_failures_raise_tts_error() -> None:
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503)

    with pytest.raises(TtsError):
        _client(handler).synthesize("hi", "v")
    assert calls["n"] == 4  # 1 initial + 3 retries, then give up


def test_timeout_retries_then_raises() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(TtsError):
        _client(handler).synthesize("hi", "v")
    assert calls["n"] == 4


def test_4xx_is_not_retried() -> None:
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(422)

    with pytest.raises(TtsError):
        _client(handler, tts_format="mp3").synthesize("hi", "v")
    assert calls["n"] == 1  # 4xx never retries (mp3 is not the opus default)


def test_opus_rejected_falls_back_to_mp3() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fmt = json.loads(request.content)["response_format"]
        seen.append(fmt)
        if fmt == "opus":
            return httpx.Response(400)
        return httpx.Response(200, content=b"MP3-bytes")

    data, fmt = _client(handler).synthesize("hi", "v")  # tts_format default opus
    assert (data, fmt) == (b"MP3-bytes", "mp3")
    assert seen == ["opus", "mp3"]


def test_list_voices_tries_audio_voices_then_voices() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path.endswith("/audio/voices"):
            return httpx.Response(404)
        return httpx.Response(200, json=["ashley-en", "ashley-zh"])

    voices = _client(handler).list_voices()
    assert [v.id for v in voices] == ["ashley-en", "ashley-zh"]
    assert seen == ["/v1/audio/voices", "/v1/voices"]


def test_list_voices_raises_when_both_endpoints_fail() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    with pytest.raises(TtsError):
        _client(handler).list_voices()
