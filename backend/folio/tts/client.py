"""OpenAI-compatible TTS client (spec: TTS audio generation → Backend contract).

Only the standard request shape is relied on, so any compatible server works.
Verified against the homelab Qwen3 service (docs/TTS.md).
"""

from __future__ import annotations

import heapq
import itertools
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Self

import httpx

from folio.config import Settings
from folio.metrics import TTS_REQUEST_SECONDS, TTS_REQUESTS_TOTAL
from folio.tts import SynthesisCancelled, TtsError, Voice
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


# How often a request waiting for a slot checks whether its job was cancelled.
_CANCEL_POLL_S = 0.25


class _Slots:
    """A counting semaphore that hands a free slot to the most urgent waiter
    (lowest priority number, then first come) instead of whoever woke first.

    The worker's audio lanes run side by side: after a play, seek or voice
    change one synthesizes the segment the listener waits on (PRIORITY_NOW)
    while the other starts its lookahead. First come, first served split the
    engine between them, so the waited-on segment took about twice as long.
    """

    def __init__(self, count: int) -> None:
        self._free = count
        self._cond = threading.Condition()
        self._waiting: list[tuple[int, int]] = []
        self._order = itertools.count()

    @contextmanager
    def hold(self, priority: int = 0, cancel: threading.Event | None = None) -> Iterator[None]:
        """Hold one slot; raises SynthesisCancelled (holding nothing) once
        ``cancel`` is set while waiting."""
        with self._cond:
            ticket = (priority, next(self._order))
            heapq.heappush(self._waiting, ticket)
            try:
                while True:
                    if cancel is not None and cancel.is_set():
                        raise SynthesisCancelled
                    if self._free > 0 and self._waiting[0] == ticket:
                        break
                    self._cond.wait(_CANCEL_POLL_S if cancel is not None else None)
            except BaseException:
                self._waiting.remove(ticket)
                heapq.heapify(self._waiting)
                self._cond.notify_all()  # the next in line may be at the head now
                raise
            heapq.heappop(self._waiting)
            self._free -= 1
            self._cond.notify_all()  # a second free slot goes to the next in line
        try:
            yield
        finally:
            with self._cond:
                self._free += 1
                self._cond.notify_all()


_SLOTS: dict[int, _Slots] = {}
_SLOTS_LOCK = threading.Lock()


def _slots(count: int) -> _Slots:
    """The process-wide cap on TTS requests in flight (the effective
    concurrency: Admin → Voices → TTS server, else TTS_CONCURRENCY): the
    worker's audio lanes and each segment's parallel sentences share it.

    Keyed by the count, so an admin change takes a fresh semaphore on the next
    request while those already under the old one finish: for that moment up
    to old + new requests can be in flight. Accepted; it ends with them.
    """
    with _SLOTS_LOCK:
        return _SLOTS.setdefault(count, _Slots(count))


class TtsClient:
    """Pass the effective settings (``folio.integrations.effective_tts_settings``)
    so the admin's TTS server, key and concurrency apply.

    ``priority`` orders this client's requests for a free slot (the queue row's
    priority; lower goes first, previews and tests use 0). Once ``cancel`` is
    set, requests still waiting for a slot raise SynthesisCancelled.
    """

    def __init__(
        self,
        settings: Settings,
        timeout: float = _TIMEOUT_S,
        *,
        priority: int = 0,
        cancel: threading.Event | None = None,
    ) -> None:
        self.settings = settings
        self.priority = priority
        self.cancel = cancel
        headers = {}
        if settings.tts_api_key:
            headers["Authorization"] = f"Bearer {settings.tts_api_key}"
        self._client = httpx.Client(timeout=timeout, headers=headers)

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
        retries included (spec: Observability); the time excludes waiting for a
        free slot under TTS_CONCURRENCY.
        """
        slots = _slots(max(1, self.settings.tts_concurrency))
        with slots.hold(self.priority, self.cancel):
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
