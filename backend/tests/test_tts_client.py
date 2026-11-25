"""TtsClient: pinned request body, bearer auth, retry/backoff, opus->mp3, discovery."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import httpx
import pytest

from folio.config import Settings
from folio.tts import SynthesisCancelled, TtsClient, TtsError
from folio.tts.adts import adts_duration
from folio.tts.client import _Slots


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


_REAL_SLEEP = time.sleep


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
    formats: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        formats.append(json.loads(request.content)["response_format"])
        return httpx.Response(422)

    with pytest.raises(TtsError):
        _client(handler, tts_format="mp3").synthesize("hi", "v")
    # 4xx never retries (mp3 is not the opus default); the PCM stream is tried once.
    assert formats == ["pcm", "mp3"]


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


def _until(condition: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.005)


def test_a_free_slot_goes_to_the_most_urgent_waiter() -> None:
    """After a voice change the worker's two lanes synthesize the segment the
    listener waits on (priority 10) and its lookahead (101) side by side. First
    come, first served split the engine between them, so the waited-on segment
    took about twice as long to start."""
    slots = _Slots(1)
    order: list[int] = []
    held = slots.hold(0)
    held.__enter__()

    def take(priority: int) -> None:
        with slots.hold(priority):
            order.append(priority)

    late = threading.Thread(target=take, args=(101,))
    late.start()
    _until(lambda: len(slots._waiting) == 1)
    urgent = threading.Thread(target=take, args=(10,))
    urgent.start()
    _until(lambda: len(slots._waiting) == 2)
    held.__exit__(None, None, None)
    late.join(2)
    urgent.join(2)
    assert order == [10, 101]


def test_a_cancelled_waiter_leaves_the_line_without_a_slot() -> None:
    slots = _Slots(1)
    cancel = threading.Event()
    outcome: list[str] = []
    held = slots.hold(0)
    held.__enter__()

    def wait_for_slot() -> None:
        try:
            with slots.hold(10, cancel):
                outcome.append("held")
        except SynthesisCancelled:
            outcome.append("cancelled")

    waiter = threading.Thread(target=wait_for_slot)
    waiter.start()
    _until(lambda: len(slots._waiting) == 1)
    cancel.set()
    waiter.join(2)
    assert outcome == ["cancelled"] and slots._waiting == []
    held.__exit__(None, None, None)
    with slots.hold(200):  # the slot was never leaked
        pass


def test_a_cancelled_job_sends_no_request() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, content=b"ID3")

    cancel = threading.Event()
    cancel.set()
    client = TtsClient(_settings(), cancel=cancel)
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(SynthesisCancelled):
        client.synthesize("hi", "v")
    assert requests == []


_PCM_HEADERS = {"Content-Type": "audio/pcm", "X-Sample-Rate": "24000"}
_ONE_SECOND = b"\x10\x00\xf0\xff" * 12000  # 24 kHz mono s16le


def test_an_engine_that_streams_pcm_has_the_clip_encoded_here() -> None:
    """fish-s2 only stops a request whose client hangs up if it is streamed, and
    it streams only raw PCM: Folio asks for that and makes the clip itself."""
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, headers=_PCM_HEADERS, content=_ONE_SECOND)

    data, fmt = _client(handler, tts_format="aac").synthesize("hi", "v", "Warm.")

    assert fmt == "aac"
    assert adts_duration(data) == pytest.approx(1.0, abs=0.1)
    assert [(b["response_format"], b["stream"], b["instructions"]) for b in bodies] == [
        ("pcm", True, "Warm.")
    ]


def test_a_cancelled_streamed_request_hangs_up_mid_stream() -> None:
    """A narrator change used to leave the engine finishing the abandoned
    request (~110 s of GPU for a Chinese segment), queueing what the listener
    was waiting for behind it."""
    cancel = threading.Event()
    sent: list[int] = []

    def chunks() -> Any:
        for n in range(50):
            sent.append(n)
            if n == 2:
                cancel.set()  # the worker's row was deleted
            yield b"\x00\x00" * 2400

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers=_PCM_HEADERS, content=chunks())

    client = TtsClient(_settings(tts_format="aac"), cancel=cancel)
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(SynthesisCancelled):
        client.synthesize("hi", "v")
    assert len(sent) < 10  # stopped reading: the connection closes and the engine stops


@pytest.mark.parametrize(
    "refusal",
    [httpx.Response(400), httpx.Response(200, content=b"not pcm")],
    ids=["rejects pcm", "ignores stream"],
)
def test_an_engine_that_cannot_stream_pcm_is_asked_the_usual_way_from_then_on(
    refusal: httpx.Response,
) -> None:
    formats: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        formats.append(body["response_format"])
        return refusal if body["response_format"] == "pcm" else httpx.Response(200, content=b"ID3")

    client = _client(handler, tts_format="mp3")
    assert client.synthesize("hi", "v") == (b"ID3", "mp3")
    assert client.synthesize("hi", "v") == (b"ID3", "mp3")
    assert formats == ["pcm", "mp3", "mp3"]


def test_opus_clips_are_never_streamed() -> None:
    formats: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        formats.append(json.loads(request.content)["response_format"])
        return httpx.Response(200, content=b"OggS")

    _client(handler).synthesize("hi", "v")
    assert formats == ["opus"]


def test_a_cancel_hangs_up_while_the_engine_has_not_answered_yet() -> None:
    """A busy engine queues the request: no chunk arrives to notice a cancel
    by, and the abandoned request kept its place in the engine's queue."""
    cancel = threading.Event()
    hung_up = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        cancel.set()  # the job is cancelled while the engine has said nothing
        if not hung_up.wait(5):
            return httpx.Response(200, headers=_PCM_HEADERS, content=_ONE_SECOND)
        raise httpx.ReadError("connection closed", request=request)

    client = TtsClient(_settings(tts_format="aac"), cancel=cancel)
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    real_close = client._client.close

    def close() -> None:
        hung_up.set()
        real_close()

    client._client.close = close  # type: ignore[method-assign]
    started = time.monotonic()
    with pytest.raises(SynthesisCancelled):
        client.synthesize("hi", "v")
    assert time.monotonic() - started < 2


def test_a_cancel_hangs_up_a_real_connection_the_engine_has_not_answered(
    mock_tts: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Over a real socket: closing an httpx client does not interrupt a read
    still waiting for the engine; the hang-up must shut the socket."""
    from mock_tts import CONFIG

    monkeypatch.setattr(time, "sleep", _REAL_SLEEP)  # the mock engine really waits
    CONFIG["first_delay_s"] = 3.0
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    client = TtsClient(_settings(tts_base_url=f"{mock_tts}/v1", tts_format="aac"), cancel=cancel)
    started = time.monotonic()
    with pytest.raises(SynthesisCancelled):
        client.synthesize("hi", "v")
    assert time.monotonic() - started < 2
