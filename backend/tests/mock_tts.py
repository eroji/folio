"""Stdlib mock of an OpenAI-compatible TTS server for tests.

``serve()`` runs a threaded http.server on an ephemeral port and yields its
base URL. ``POST /v1/audio/speech`` returns a 1-second silent Ogg/Opus file
(generated once with ffmpeg and embedded below — see docs/DECISIONS.md);
``GET /v1/audio/voices`` returns the pinned voice list. Every request is
recorded in ``REQUESTS`` as ``(method, path, authorization header)``.
"""

from __future__ import annotations

import base64
import contextlib
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


class _Handler(BaseHTTPRequestHandler):
    def _record(self) -> None:
        REQUESTS.append((self.command, self.path, self.headers.get("Authorization")))
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)

    def do_POST(self) -> None:
        self._record()
        if self.path == "/v1/audio/speech":
            self._send(200, "audio/ogg", SILENT_OPUS)
        else:
            self._send(404, "application/json", b'{"error": "not found"}')

    def do_GET(self) -> None:
        self._record()
        if self.path == "/v1/audio/voices":
            self._send(200, "application/json", json.dumps(VOICES).encode())
        else:
            self._send(404, "application/json", b'{"error": "not found"}')

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass  # keep test output clean


@contextlib.contextmanager
def serve() -> Iterator[str]:
    """Start the mock on an ephemeral port; yield its base URL."""
    REQUESTS.clear()
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
