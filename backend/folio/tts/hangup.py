"""An httpx client whose requests can be hung up from another thread.

fish-s2-openai stops generating only when the client of a *streamed* request
hangs up. Closing an httpx client does not interrupt a request blocked waiting
for the engine to answer (a busy engine queues it): the read only fails once
data arrives. Shutting the socket down does, at once; httpx exposes no socket
before the response, so the connection layer records them as they open.
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Callable
from typing import Any

import httpcore
import httpx


class _Sockets(httpcore.SyncBackend):
    """httpcore's own backend, remembering each connection it opens."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._streams: list[httpcore.NetworkStream] = []
        self._hung_up = False

    def connect_tcp(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        stream = super().connect_tcp(*args, **kwargs)
        with self._lock:
            self._streams.append(stream)
            hung_up = self._hung_up
        if hung_up:
            _shut(stream)  # hung up while connecting
        return stream

    def hang_up(self) -> None:
        with self._lock:
            self._hung_up = True
            streams = list(self._streams)
        for stream in streams:
            _shut(stream)


def _shut(stream: httpcore.NetworkStream) -> None:
    sock = stream.get_extra_info("socket")
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # already closed


def hang_up_client(
    timeout: float, headers: dict[str, str] | None = None
) -> tuple[httpx.Client, Callable[[], None]]:
    """A client, and a function that hangs up every request it has open (and
    any it opens after): they fail at once, and the engine sees the hang-up."""
    sockets = _Sockets()
    transport = httpx.HTTPTransport()
    # ponytail: httpx 0.28 has no public hook for the network backend; the
    # hang-up tests (test_live, test_tts_client) fail if this stops working.
    transport._pool = httpcore.ConnectionPool(network_backend=sockets)
    return httpx.Client(timeout=timeout, headers=headers, transport=transport), sockets.hang_up
