"""Stdlib mock of an OpenAI-compatible TTS server for tests.

``serve()`` runs a threaded http.server on an ephemeral port and yields its
base URL. ``POST /v1/audio/speech`` returns a 1-second silent Ogg/Opus file
(generated once with ffmpeg and embedded below — see docs/DECISIONS.md);
``GET /v1/audio/voices`` returns the pinned voice list. Every request is
recorded in ``REQUESTS`` as ``(method, path, authorization header)`` and every
speech body in ``BODIES``.

``response_format: "pcm"`` answers like fish-s2-openai: raw s16le mono at
``PCM_RATE`` (``X-Sample-Rate``), ``PCM_SECONDS_PER_CHAR`` of it per input
character; with ``stream: true`` it is sent in chunks as it is "generated"
(``STREAM_DELAY_S`` between them, no Content-Length). ``CONFIG["reject_pcm"]``
answers 400 instead, like an engine that cannot do PCM.
"""

from __future__ import annotations

import base64
import contextlib
import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

SILENT_OPUS = base64.b64decode(
    """
    T2dnUwACAAAAAAAAAAAAAAAAAAAAAAIotXIBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAA
    AAAAAAAAAAABAAAASZW+VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMg
    bGlib3B1c09nZ1MAAIC7AAAAAAAAAAAAAAIAAACQyi3xMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD
    AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD+P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+
    +P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+
    +P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/++P/+
    +P/++P/+T2dnUwAEuLwAAAAAAAAAAAAAAwAAAIJ4TqYBA/j//g==
    """
)

VOICES = {"voices": [{"id": "ashley-en", "language": "en"}]}
REQUESTS: list[tuple[str, str, str | None]] = []
BODIES: list[dict[str, Any]] = []
PCM_RATE = 24000
PCM_SECONDS_PER_CHAR = 0.01
CONFIG: dict[str, Any] = {"reject_pcm": False, "stream_delay_s": 0.0}


def pcm_for(text: str) -> bytes:
    """Quiet noise (not digital silence) so an encoder makes real frames."""
    samples = max(1, int(len(text) * PCM_SECONDS_PER_CHAR * PCM_RATE))
    return b"\x10\x00\xf0\xff" * (samples // 2) + b"\x00\x00" * (samples % 2)


class _Handler(BaseHTTPRequestHandler):
    def _record(self) -> bytes:
        REQUESTS.append((self.command, self.path, self.headers.get("Authorization")))
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self) -> None:
        raw = self._record()
        if self.path == "/v1/audio/speech":
            body = json.loads(raw or b"{}")
            BODIES.append(body)
            if body.get("response_format") == "pcm":
                self._pcm(str(body.get("input", "")), bool(body.get("stream")))
            else:
                self._send(200, "audio/ogg", SILENT_OPUS)
        else:
            self._send(404, "application/json", b'{"error": "not found"}')

    def do_GET(self) -> None:
        self._record()
        if self.path == "/v1/audio/voices":
            self._send(200, "application/json", json.dumps(VOICES).encode())
        else:
            self._send(404, "application/json", b'{"error": "not found"}')

    def _pcm(self, text: str, stream: bool) -> None:
        if CONFIG["reject_pcm"]:
            self._send(400, "application/json", b'{"error": "unsupported format"}')
            return
        data = pcm_for(text)
        if not stream:
            self._send(200, "audio/pcm", data, {"X-Sample-Rate": str(PCM_RATE)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/pcm")
        self.send_header("X-Sample-Rate", str(PCM_RATE))
        self.end_headers()  # no length: read until the connection closes
        try:
            for start in range(0, len(data), 4800):  # 0.1 s chunks
                self.wfile.write(data[start : start + 4800])
                self.wfile.flush()
                time.sleep(CONFIG["stream_delay_s"])
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client hung up: an aborted generation

    def _send(
        self, status: int, content_type: str, body: bytes, headers: dict[str, str] | None = None
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass  # keep test output clean


@contextlib.contextmanager
def serve() -> Iterator[str]:
    """Start the mock on an ephemeral port; yield its base URL."""
    REQUESTS.clear()
    BODIES.clear()
    CONFIG.update(reject_pcm=False, stream_delay_s=0.0)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    with serve() as url:
        print(f"mock TTS on {url} (Ctrl-C to stop)")
        threading.Event().wait()
