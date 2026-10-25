"""Prometheus metrics: ``GET /metrics`` (unauthenticated), HTTP middleware, gauges.

Labels carry route templates, statuses and result words only — never ids,
titles or usernames (spec: Observability; M6 plan constraint). The queue-depth
and cache-size gauges are computed at scrape time so the API and the worker
need no extra plumbing.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from folio.db import get_session
from folio.models import Audio, Job

router = APIRouter(tags=["metrics"])

HTTP_REQUESTS_TOTAL = Counter(
    "folio_http_requests_total",
    "HTTP requests by method, route template and status code.",
    ("method", "path", "status"),
)
TTS_REQUESTS_TOTAL = Counter(
    "folio_tts_requests_total",
    "TTS synthesis calls by result (ok or error, retries counted once).",
    ("result",),
)
TTS_REQUEST_SECONDS = Histogram(
    "folio_tts_request_seconds", "Wall time of one TTS synthesis call in seconds."
)
JOBS = Gauge("folio_jobs", "Jobs by status.", ("status",))
AUDIO_CACHE_BYTES = Gauge("folio_audio_cache_bytes", "Total bytes of cached synthesized audio.")
SSE_LISTENERS = Gauge("folio_sse_listeners", "Currently open SSE connections.")

# Pinned by the M6 plan: the classic text exposition, not OpenMetrics 1.0.0
# (what ``prometheus_client.CONTENT_TYPE_LATEST`` reports in 0.26).
EXPOSITION_TYPE = "text/plain; version=0.0.4; charset=utf-8"

# Statuses the job worker ever writes; zero-filled so scrapes stay comparable.
JOB_STATUSES = ("queued", "running", "done", "failed")


def update_scrape_gauges(db: DbSession) -> None:
    """Refresh the DB-backed gauges just before exposition."""
    counts = dict(db.execute(select(Job.status, func.count()).group_by(Job.status)).all())
    for status in JOB_STATUSES:
        JOBS.labels(status).set(counts.pop(status, 0))
    for status, count in counts.items():  # unexpected statuses still show up
        JOBS.labels(status).set(count)
    AUDIO_CACHE_BYTES.set(db.scalar(select(func.coalesce(func.sum(Audio.bytes), 0))) or 0)


@router.get("/metrics", include_in_schema=False)
def metrics(db: Annotated[DbSession, Depends(get_session)]) -> Response:
    update_scrape_gauges(db)
    # Body is prometheus-client 0.26's text format; the header stays pinned to
    # 0.0.4 per the plan (the extra ``# EOF`` line parses as a comment there).
    return Response(generate_latest(), media_type=EXPOSITION_TYPE)


class HttpMetricsMiddleware:
    """Count every request against its route template.

    Pure ASGI on purpose: BaseHTTPMiddleware copies the scope, so the
    ``scope["route"]`` starlette sets during routing would not be visible
    after the call and real ids would leak into the ``path`` label.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        status = 500  # an app that dies before responding still counts

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            route = scope.get("route")
            path = route.path if route is not None else "unmatched"
            HTTP_REQUESTS_TOTAL.labels(scope["method"], path, str(status)).inc()
