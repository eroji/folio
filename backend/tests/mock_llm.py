"""Stdlib mock of an OpenAI-compatible chat completions server for tests.

``serve(answer, models)`` runs a threaded http.server on an ephemeral port and
yields ``(base_url, requests)``; GET /v1/models lists ``models`` when given. ``answer(body)`` returns ``(status, payload)`` for
each POST /v1/chat/completions; every request body is appended to
``requests``. ``completion(text)`` builds a normal answer.
"""

from __future__ import annotations

import contextlib
import json
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

Answer = Callable[[dict[str, Any]], tuple[int, dict[str, Any]]]


def completion(text: str, model: str = "mock-model") -> tuple[int, dict[str, Any]]:
    return 200, {"model": model, "choices": [{"message": {"role": "assistant", "content": text}}]}


def prompt_text(body: dict[str, Any]) -> str:
    """All text parts of a request's messages, joined."""
    out = []
    for message in body.get("messages", []):
        content = message.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            out += [part.get("text", "") for part in content if part.get("type") == "text"]
    return "\n".join(out)


def has_image(body: dict[str, Any]) -> bool:
    return any(
        isinstance(m.get("content"), list)
        and any(p.get("type") == "image_url" for p in m["content"])
        for m in body.get("messages", [])
    )


@contextlib.contextmanager
def serve(
    answer: Answer, models: list[str] | None = None
) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    requests: list[dict[str, Any]] = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            body["_auth"] = self.headers.get("Authorization")
            with lock:
                requests.append(body)
            if self.path != "/v1/chat/completions":
                status, payload = 404, {"error": {"message": "not found"}}
            else:
                status, payload = answer(body)
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/v1/models" and models is not None:
                status, payload = 200, {"object": "list", "data": [{"id": m} for m in models]}
            else:
                status, payload = 404, {"error": {"message": "not found"}}
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
