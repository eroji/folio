"""The language model client: chat completions, page reading, errors an admin can act on."""

from __future__ import annotations

import pytest
from mock_llm import completion, has_image, serve

from folio.integrations import LanguageModel
from folio.llm import LlmError, chat, parse_json, read_page


def _cfg(base_url: str, **extra: object) -> LanguageModel:
    return LanguageModel(base_url=base_url, api_key="sk-secret-1234", model="chat-model", **extra)  # type: ignore[arg-type]


def test_chat_sends_the_model_and_key_and_drops_reasoning() -> None:
    with serve(lambda body: completion("<think>hmm, let me see</think>\nHello.")) as (
        url,
        requests,
    ):
        reply = chat(_cfg(url), [{"role": "user", "content": "Say hello"}])
    assert reply.text == "Hello."
    assert reply.model == "mock-model" and reply.latency_ms >= 0
    assert requests[0]["model"] == "chat-model"
    assert requests[0]["_auth"] == "Bearer sk-secret-1234"


@pytest.mark.parametrize(
    ("status", "words"),
    [
        (401, "refused the API key"),
        (404, "ends in /v1"),
        (429, "rate limiting"),
        (500, "HTTP 500: boom"),
    ],
)
def test_failures_read_as_admin_actions_and_never_carry_the_key(status: int, words: str) -> None:
    with (
        serve(lambda body: (status, {"error": {"message": "boom"}})) as (url, _),
        pytest.raises(LlmError) as raised,
    ):
        chat(_cfg(url), [{"role": "user", "content": "x"}])
    assert words in str(raised.value)
    assert "sk-secret" not in str(raised.value)


def test_unreachable_and_unconfigured() -> None:
    with pytest.raises(LlmError, match="Could not reach"):
        chat(_cfg("http://127.0.0.1:9/v1"), [{"role": "user", "content": "x"}], timeout=2)
    with pytest.raises(LlmError, match="not set up"):
        chat(LanguageModel(), [{"role": "user", "content": "x"}])


def test_read_page_sends_the_image_to_the_reading_model() -> None:
    with serve(lambda body: completion("```\nIt was a dark night.\n```")) as (url, requests):
        reply = read_page(_cfg(url, ocr_model="vision-model"), b"\x89PNG fake", "image/png", "en")
    assert reply.text == "It was a dark night."
    assert requests[0]["model"] == "vision-model"
    assert has_image(requests[0])
    image = requests[0]["messages"][0]["content"][1]["image_url"]["url"]
    assert image.startswith("data:image/png;base64,")


def test_parse_json_finds_the_object_in_prose_or_fences() -> None:
    assert parse_json('Sure! ```json\n{"a": 1}\n``` done') == {"a": 1}
    with pytest.raises(LlmError):
        parse_json("no json here")
