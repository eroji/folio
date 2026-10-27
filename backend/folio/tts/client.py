"""OpenAI-compatible TTS client (spec: TTS audio generation → Backend contract).

Only the standard request shape is relied on, so any compatible server works.
Verified against the homelab Qwen3 service (docs/TTS.md).
"""

from __future__ import annotations

import time
from typing import Any, Self

import httpx

from folio.config import Settings
from folio.metrics import TTS_REQUEST_SECONDS, TTS_REQUESTS_TOTAL
from folio.tts import TtsError, Voice
from folio.tts.voices import parse_voices_payload

# 1 initial try + 3 retries, backing off 1 s, 4 s, 16 s (spec: Retries).
_BACKOFF: tuple[float, ...] = (1.0, 4.0, 16.0)
_TIMEOUT_S = 60.0
_DEFAULT_FORMAT = "opus"


class _Rejected(Exception):
    """The server answered 4xx: no retry, but opus may fall back to mp3."""

    def __init__(self, status: int) -> None:
        super().__init__(f"tts rejected request ({status})")
        self.status = status


class TtsClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        headers = {}
        if settings.tts_api_key:
            headers["Authorization"] = f"Bearer {settings.tts_api_key}"
        self._client = httpx.Client(timeout=_TIMEOUT_S, headers=headers)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _base(self) -> str:
        if not self.settings.tts_base_url:
            raise TtsError("TTS is not configured", code="tts_not_configured")
        return self.settings.tts_base_url.rstrip("/")

    def synthesize(
        self, text: str, voice: str, instructions: str | None = None
    ) -> tuple[bytes, str]:
        """Return ``(audio_bytes, format)`` for ``text`` in ``voice``.

        ``instructions`` is the narration prompt sent alongside (omitted when
        empty). One counter increment and one histogram observation per call,
        retries included (spec: Observability).
        """
        start = time.perf_counter()
        result = "error"
        try:
            out = self._synthesize(text, voice, instructions)
            result = "ok"
            return out
        finally:
            TTS_REQUESTS_TOTAL.labels(result).inc()
            TTS_REQUEST_SECONDS.observe(time.perf_counter() - start)

    def _synthesize(
        self, text: str, voice: str, instructions: str | None = None
    ) -> tuple[bytes, str]:
        fmt = self.settings.tts_format
        try:
            return self._speech(text, voice, fmt, instructions), fmt
        except _Rejected:
            # Opus is the default and the engine rejected it: try mp3 once.
            if fmt != _DEFAULT_FORMAT:
                raise TtsError("TTS rejected the request", code="tts_rejected") from None
            try:
                return self._speech(text, voice, "mp3", instructions), "mp3"
            except _Rejected:
                raise TtsError("TTS rejected the request", code="tts_rejected") from None

    def _speech(self, text: str, voice: str, fmt: str, instructions: str | None = None) -> bytes:
        body: dict[str, Any] = {
            "model": self.settings.tts_model,
            "voice": voice,
            "input": text,
            "response_format": fmt,
            "speed": 1.0,
        }
        if instructions:
            body["instructions"] = instructions
        url = f"{self._base()}/audio/speech"
        for attempt in range(len(_BACKOFF) + 1):
            try:
                response = self._client.post(url, json=body)
            except httpx.TimeoutException as exc:
                if attempt >= len(_BACKOFF):
                    raise TtsError("TTS request timed out", code="tts_timeout") from exc
                time.sleep(_BACKOFF[attempt])
                continue
            if response.status_code >= 500:
                if attempt >= len(_BACKOFF):
                    raise TtsError("TTS backend unavailable", code="tts_unavailable")
                time.sleep(_BACKOFF[attempt])
                continue
            if response.status_code >= 400:
                raise _Rejected(response.status_code)
            return response.content
        raise TtsError("TTS request failed", code="tts_unavailable")  # pragma: no cover

    def list_voices(self) -> list[Voice]:
        """Query the engine's voice endpoints; raise TtsError if neither answers."""
        base = self._base()
        try:
            response = self._client.get(f"{base}/audio/voices")
            if response.status_code == 404:
                response = self._client.get(f"{base}/voices")
        except httpx.HTTPError as exc:
            raise TtsError("TTS voice discovery failed", code="tts_unavailable") from exc
        if response.status_code >= 400:
            raise TtsError("TTS voice discovery failed", code="tts_unavailable")
        return parse_voices_payload(response.json(), self.settings)
