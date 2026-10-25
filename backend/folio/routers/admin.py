"""Admin API: job list, user directory and audio cache tools, admin-only."""

import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import require_admin
from folio.errors import ApiError
from folio.jobs import notify
from folio.models import Audio, Book, Chapter, Job, Segment, SegmentAudio, User
from folio.routers.auth import UserPublic
from folio.security import require_csrf

router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])

JOBS_PAGE_SIZE = 100
TTS_HEALTH_TIMEOUT_S = 2.0


class JobPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    type: str
    book_id: UUID | None
    priority: int
    status: str
    attempts: int
    error: str | None
    created_at: datetime
    finished_at: datetime | None


@router.get("/jobs")
def list_jobs(db: Annotated[DbSession, Depends(get_session)]) -> dict[str, Any]:
    jobs = db.scalars(select(Job).order_by(Job.created_at.desc()).limit(JOBS_PAGE_SIZE)).all()
    return {"items": [JobPublic.model_validate(j) for j in jobs]}


@router.get("/users")
def list_users(db: Annotated[DbSession, Depends(get_session)]) -> dict[str, Any]:
    users = db.scalars(select(User).order_by(User.username)).all()
    return {"items": [UserPublic.model_validate(u) for u in users]}


@router.post("/jobs/{job_id}/retry", status_code=202)
def retry_job(
    request: Request,
    job_id: UUID,
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """Re-queue a finished job (failed or done); a live job is left alone."""
    require_csrf(request, request.state.session_row)
    job = db.get(Job, job_id)
    if job is None:
        raise ApiError("not_found", "Job not found.", 404)
    if job.status in ("queued", "running"):
        raise ApiError("conflict", "Job is already queued or running.", 409)
    job.status, job.error, job.finished_at = "queued", None, None
    db.commit()
    notify(db, {"event": "job", "job_id": str(job.id), "status": "queued"})
    return {"job": JobPublic.model_validate(job)}


@router.get("/cache")
def cache_stats(
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Audio-cache size plus a live TTS probe, for the admin page."""
    files, total = db.execute(select(func.count(), func.coalesce(func.sum(Audio.bytes), 0))).one()
    status, latency_ms = probe_tts_timed(settings)
    return {
        "files": files,
        "bytes": int(total),
        "tts": {"status": status, "latency_ms": latency_ms},
    }


class CacheClearBody(BaseModel):
    book_id: UUID | None = None


@router.post("/cache/clear")
def clear_cache(
    request: Request,
    body: CacheClearBody,
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, int]:
    """Delete cached clips (files + audio rows), entirely or for one book.

    Per book only the keys referenced by that book's segment_audio rows go.
    The FK ON DELETE SET NULL detaches them; the next prepare re-queues.
    """
    require_csrf(request, request.state.session_row)
    stmt = select(Audio.cache_key, Audio.path, Audio.bytes)
    if body.book_id is not None:
        if db.get(Book, body.book_id) is None:
            raise ApiError("not_found", "Book not found.", 404)
        stmt = stmt.where(
            Audio.cache_key.in_(
                select(SegmentAudio.cache_key)
                .join(Segment, SegmentAudio.segment_id == Segment.id)
                .join(Chapter, Segment.chapter_id == Chapter.id)
                .where(Chapter.book_id == body.book_id, SegmentAudio.cache_key.is_not(None))
            )
        )
    rows = db.execute(stmt).all()
    for _key, path, _bytes in rows:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass  # a stale path must not block the clear; the row still goes
    db.execute(delete(Audio).where(Audio.cache_key.in_([key for key, _p, _b in rows])))
    db.commit()
    return {"removed_files": len(rows), "freed_bytes": sum(size for _k, _p, size in rows)}


def probe_tts(settings: Settings) -> str:
    """Liveness of the TTS backend for admin health: GET {base without /v1}/health."""
    return probe_tts_timed(settings)[0]


def probe_tts_timed(settings: Settings) -> tuple[str, int | None]:
    """``(status, latency_ms)``; latency is None unless the probe answered 2xx/3xx."""
    if not settings.tts_base_url:
        return "not_configured", None
    base = settings.tts_base_url.rstrip("/").removesuffix("/v1")
    start = time.perf_counter()
    try:
        response = httpx.get(f"{base}/health", timeout=TTS_HEALTH_TIMEOUT_S)
    except httpx.HTTPError:
        return "unreachable", None
    if response.status_code >= 400:
        return "unreachable", None
    return "ok", round((time.perf_counter() - start) * 1000)
