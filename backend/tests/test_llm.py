"""The language model client: chat completions, page reading, errors an admin can act on."""

from __future__ import annotations

from typing import Any

import pytest
from mock_llm import completion, has_image, serve

from folio.integrations import LanguageModel
from folio.llm import LlmError, chat, list_models, parse_json, read_page


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


# --- Thinking off by default, and what happens when a model thinks anyway ---


def test_requests_ask_the_model_not_to_think_unless_allowed() -> None:
    with serve(lambda body: completion("ok")) as (url, requests):
        chat(_cfg(url), [{"role": "user", "content": "x"}])
        chat(_cfg(url, thinking=True), [{"role": "user", "content": "x"}])
    assert requests[0]["chat_template_kwargs"] == {"enable_thinking": False}
    assert "chat_template_kwargs" not in requests[1]


def test_a_server_that_rejects_the_template_field_is_asked_without_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from folio import llm

    monkeypatch.setattr(llm, "_REJECTS_TEMPLATE_KWARGS", set())

    def strict(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if "chat_template_kwargs" in body:
            return 400, {
                "error": {"message": "Unrecognized request argument supplied: chat_template_kwargs"}
            }
        return completion("ok")

    with serve(strict) as (url, requests):
        assert chat(_cfg(url), [{"role": "user", "content": "x"}]).text == "ok"
        assert chat(_cfg(url), [{"role": "user", "content": "x"}]).text == "ok"
    # Rejected once, then remembered: three requests, not four.
    assert ["chat_template_kwargs" in r for r in requests] == [True, False, False]


def test_an_answer_spent_thinking_says_so() -> None:
    def thinker(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return 200, {
            "model": "m",
            "choices": [
                {
                    "message": {"content": None, "reasoning_content": "hmm"},
                    "finish_reason": "length",
                }
            ],
            "usage": {"completion_tokens_details": {"reasoning_tokens": 2000}},
        }

    with serve(thinker) as (url, _), pytest.raises(LlmError, match="spent the answer thinking"):
        chat(_cfg(url), [{"role": "user", "content": "x"}], max_tokens=2000)


def test_reasoning_tokens_are_reported() -> None:
    def answer(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        status, payload = completion("ready")
        payload["usage"] = {"completion_tokens_details": {"reasoning_tokens": 22}}
        return status, payload

    with serve(answer) as (url, _):
        assert chat(_cfg(url), [{"role": "user", "content": "x"}]).reasoning_tokens == 22


def test_list_models_reads_the_endpoint() -> None:
    with serve(lambda body: completion("x"), models=["utility", "Uncensored", "utility"]) as (
        url,
        _,
    ):
        assert list_models(_cfg(url)) == ["Uncensored", "utility"]
    with (
        serve(lambda body: completion("x")) as (url, _),
        pytest.raises(LlmError, match="ends in /v1"),
    ):
        list_models(_cfg(url))
    with pytest.raises(LlmError, match="base URL first"):
        list_models(LanguageModel())
