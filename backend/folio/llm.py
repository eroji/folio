"""OpenAI-compatible chat completions client for the admin-configured model.

Used to read scanned pages (OCR) and to suggest pronunciation rules and a
delivery note for a book. Every failure becomes ``LlmError`` with a message an
admin can act on; the API key never appears in one.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from folio.integrations import LanguageModel

CHAT_TIMEOUT_S = 120.0
OCR_TIMEOUT_S = 180.0

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")

OCR_PROMPT = (
    "Transcribe all of the text on this book page exactly as printed, in its own "
    "language and script. Keep paragraph breaks as blank lines and join lines that "
    "a paragraph only wraps. Leave out running headers, footers and page numbers. "
    "Do not translate, summarise, correct or describe anything. Output only the "
    "page's text; output nothing if the page has no text."
)


class LlmError(Exception):
    """A failed call, worded for the admin page and the book's error line."""


@dataclass
class Reply:
    text: str
    model: str
    latency_ms: int


def _endpoint(cfg: LanguageModel) -> str:
    if not cfg.configured:
        raise LlmError("The language model is not set up (Admin → Integrations).")
    return cfg.base_url.strip().rstrip("/") + "/chat/completions"


def _content(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, list):  # some servers return content parts
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = content if isinstance(content, str) else ""
    return _THINK.sub("", text).strip()  # reasoning models think out loud first


def chat(
    cfg: LanguageModel,
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    max_tokens: int | None = None,
    timeout: float = CHAT_TIMEOUT_S,
    client: httpx.Client | None = None,
) -> Reply:
    """One chat completion; ``LlmError`` on any failure."""
    url = _endpoint(cfg)
    use_model = (model or cfg.model).strip()
    body: dict[str, Any] = {"model": use_model, "messages": messages, "temperature": 0}
    if max_tokens:
        body["max_tokens"] = max_tokens
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    started = time.monotonic()
    own = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        response = http.post(url, json=body, headers=headers, timeout=timeout)
    except httpx.TimeoutException:
        raise LlmError(f"The language model did not answer within {timeout:.0f} s.") from None
    except httpx.HTTPError as exc:
        raise LlmError(f"Could not reach the language model ({type(exc).__name__}).") from None
    finally:
        if own:
            http.close()
    latency = int((time.monotonic() - started) * 1000)
    if response.status_code in (401, 403):
        raise LlmError(f"The language model refused the API key (HTTP {response.status_code}).")
    if response.status_code == 404:
        raise LlmError(
            "The language model endpoint or model was not found (HTTP 404). "
            "The base URL usually ends in /v1."
        )
    if response.status_code == 429:
        raise LlmError("The language model is rate limiting requests (HTTP 429).")
    if response.status_code >= 400:
        raise LlmError(
            f"The language model returned HTTP {response.status_code}: {_detail(response)}"
        )
    try:
        data = response.json()
        message = data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise LlmError("The language model's answer was not a chat completion.") from None
    return Reply(
        text=_content(message), model=str(data.get("model") or use_model), latency_ms=latency
    )


def _detail(response: httpx.Response) -> str:
    """The server's own error message, shortened."""
    try:
        data = response.json()
        error = data.get("error") if isinstance(data, dict) else None
        message = error.get("message") if isinstance(error, dict) else error or data.get("detail")
        text = str(message) if message else response.text
    except ValueError:
        text = response.text
    return " ".join(text.split())[:200] or "no details"


def read_page(
    cfg: LanguageModel,
    image: bytes,
    mime: str,
    language: str | None = None,
    *,
    client: httpx.Client | None = None,
) -> Reply:
    """OCR one page image with the reading (vision) model."""
    prompt = OCR_PROMPT
    if language:
        prompt += f" The book's language is {language}."
    data_url = f"data:{mime};base64,{base64.b64encode(image).decode()}"
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]
    reply = chat(cfg, messages, model=cfg.reader, timeout=OCR_TIMEOUT_S, client=client)
    reply.text = _FENCE.sub("", reply.text).strip()
    return reply


def parse_json(text: str) -> Any:
    """The JSON object in a model's answer (tolerates code fences and prose
    around it); ``LlmError`` when there is none."""
    cleaned = _FENCE.sub("", text.strip())
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise LlmError("The language model did not answer with JSON.")
    try:
        return json.loads(cleaned[start : end + 1])
    except ValueError:
        raise LlmError("The language model's JSON could not be read.") from None
