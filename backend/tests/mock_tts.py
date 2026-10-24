"""Stdlib mock of an OpenAI-compatible TTS server for tests.

``serve()`` runs a threaded http.server on an ephemeral port and yields its
base URL. ``POST /v1/audio/speech`` returns a 1-second silent Ogg/Opus file
(generated once with ffmpeg and embedded below — see docs/DECISIONS.md);
``GET /v1/audio/voices`` returns the pinned voice list.
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
    T2dnUwACAAAAAAAAAAAb7WGRAAAAACSa16UBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAA
    AAAAABvtYZEBAAAADA25IQE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rl
    cj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAACAuwAAAAAAABvtYZECAAAAw2I67TIHBgYGBgYG
    BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBggL8fkWheAICniz
    DsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYI
    CnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICniz
    DsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYI
    CnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICnizDsYICniz
    DsZPZ2dTAAS4vAAAAAAAABvtYZEDAAAAjZQwmQEGCAp4sw7G
    """
)

VOICES = {"voices": [{"id": "ashley-en", "language": "en"}]}


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path == "/v1/audio/speech":
            self._send(200, "audio/ogg", SILENT_OPUS)
        else:
            self._send(404, "application/json", b'{"error": "not found"}')

    def do_GET(self) -> None:
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
