"""GET /api/v1/events — Server-Sent Events for live job/book status."""

import asyncio
import json
import threading
from collections.abc import AsyncIterator
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.events import KEEPALIVE_S, format_frame, listen_payloads, snapshot_frames
from folio.metrics import SSE_LISTENERS
from folio.models import User

router = APIRouter(prefix="/api/v1", tags=["events"])


@router.get("/events")
async def events(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> StreamingResponse:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    stop = threading.Event()
    dsn = get_settings().database_url.replace("+psycopg", "")
    conn = psycopg.connect(dsn, autocommit=True)
    conn.execute(
        "LISTEN folio_events"
    )  # LISTEN before the snapshot: duplicates possible, misses not
    snapshot = snapshot_frames(db)

    def pump() -> None:
        try:
            for payload in listen_payloads(conn, stop):
                loop.call_soon_threadsafe(queue.put_nowait, payload)
        except psycopg.Error:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # end the stream

    async def stream() -> AsyncIterator[str]:
        thread = threading.Thread(target=pump, daemon=True)
        thread.start()
        SSE_LISTENERS.inc()
        try:
            for frame in snapshot:
                yield frame
            while not await request.is_disconnected():
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_S)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                if payload is None:
                    break
                yield format_frame(json.loads(payload))
        finally:
            SSE_LISTENERS.dec()
            stop.set()
            thread.join(timeout=2)
            conn.close()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
