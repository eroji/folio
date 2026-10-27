"""Admin API: job list, user directory and audio cache tools, admin-only."""

import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import require_admin
from folio.errors import ApiError
from folio.jobs import notify
from folio.models import Audio, Book, Chapter, Job, Segment, SegmentAudio, User
from folio.routers.auth import UserPublic
from folio.routers.voices import get_tts_client
from folio.security import require_csrf
from folio.tts import TtsClient, discover_voices
from folio.voice_catalog import (
    MAX_INSTRUCTION_LENGTH,
    build_catalog,
    effective_defaults,
    load_voice_defaults,
    load_voice_instructions,
    load_voice_languages,
    save_voice_defaults,
    save_voice_instructions,
    save_voice_languages,
    voice_languages,
)
from folio.voice_names import MAX_NAME_LENGTH, load_overrides, resolve_display_names, save_overrides

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
    book_title: str | None = None
    user_name: str | None = None
    user_username: str | None = None


@router.get("/jobs")
def list_jobs(db: Annotated[DbSession, Depends(get_session)]) -> dict[str, Any]:
    """Newest first, with the book title and the user who triggered the job."""
    rows = db.execute(
        select(Job, Book.title, User.display_name, User.username)
        .outerjoin(Book, Job.book_id == Book.id)
        .outerjoin(User, Job.user_id == User.id)
        .order_by(Job.created_at.desc())
        .limit(JOBS_PAGE_SIZE)
    ).all()
    items = []
    for job, title, user_name, username in rows:
        item = JobPublic.model_validate(job)
        item.book_title = title
        item.user_name = user_name
        item.user_username = username
        items.append(item)
    return {"items": items}


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


def _discovered_voices(settings: Settings, client: TtsClient) -> list[tuple[str, str | None]]:
    """(id, language) of every real voice; the engine's ``tts`` entry is not one."""
    return [(v.id, v.language) for v in discover_voices(settings, client) if v.id != "tts"]


@router.get("/voice-names")
def get_voice_names(
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
) -> dict[str, Any]:
    """Override map plus the resolved name for every discovered voice."""
    voices = _discovered_voices(settings, client)
    overrides = load_overrides(db)
    names = resolve_display_names(voices, overrides)
    return {
        "names": overrides,
        "items": [
            {"id": voice_id, "display_name": names[voice_id], "overridden": voice_id in overrides}
            for voice_id, _language in voices
        ],
    }


class VoiceNamesBody(BaseModel):
    names: dict[str, str] = Field(default_factory=dict)


@router.put("/voice-names")
def put_voice_names(
    request: Request,
    body: VoiceNamesBody,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
) -> dict[str, Any]:
    """Replace the override map; trimmed-empty values remove an override."""
    require_csrf(request, request.state.session_row)
    known = dict(_discovered_voices(settings, client))
    cleaned: dict[str, str] = {}
    for voice_id, name in body.names.items():
        if voice_id not in known:
            raise ApiError("validation_failed", f"Unknown voice: {voice_id}.", 422)
        name = name.strip()
        if len(name) > MAX_NAME_LENGTH:
            raise ApiError(
                "validation_failed",
                f"Voice names must be at most {MAX_NAME_LENGTH} characters.",
                422,
            )
        if name:
            cleaned[voice_id] = name
    return {"names": save_overrides(db, cleaned)}


class VoicePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    language_override: Literal["en", "ja", "ko", "zh"] | None = None  # null = detect again
    instructions: str | None = None  # narration prompt; null/empty clears


@router.patch("/voices/{voice_id}")
def patch_voice(
    request: Request,
    voice_id: str,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
    body: VoicePatch | None = None,
) -> dict[str, Any]:
    """Save one voice's alias, language override and/or narration instruction;
    return its catalog item."""
    require_csrf(request, request.state.session_row)
    patch = body or VoicePatch()
    voices = discover_voices(settings, client)
    names = load_overrides(db)
    languages = load_voice_languages(db)
    instructions = load_voice_instructions(db)
    known = {v.id for v in voices} | names.keys() | languages.keys() | instructions.keys()
    if voice_id not in known:
        raise ApiError("validation_failed", f"Unknown voice: {voice_id}.", 422)
    fields = patch.model_dump(exclude_unset=True)
    if "display_name" in fields:
        name = (patch.display_name or "").strip()
        if len(name) > MAX_NAME_LENGTH:
            raise ApiError(
                "validation_failed",
                f"Voice names must be at most {MAX_NAME_LENGTH} characters.",
                422,
            )
        if name:
            names[voice_id] = name
        else:
            names.pop(voice_id, None)
        save_overrides(db, names)
    if "language_override" in fields:
        if patch.language_override is None:
            languages.pop(voice_id, None)  # unassign: detect again
        else:
            languages[voice_id] = patch.language_override
        save_voice_languages(db, languages)
    if "instructions" in fields:
        text = (patch.instructions or "").strip()
        if len(text) > MAX_INSTRUCTION_LENGTH:
            raise ApiError(
                "validation_failed",
                f"Narration instructions must be at most {MAX_INSTRUCTION_LENGTH} characters.",
                422,
            )
        if text:
            instructions[voice_id] = text
        else:
            instructions.pop(voice_id, None)
        save_voice_instructions(db, instructions)
    items = build_catalog(db, voices, include_tts=True)["items"]
    item = next((i for i in items if i["id"] == voice_id), None)
    if item is None:  # unreachable: the id is in the engine list or in one of the maps
        raise ApiError("not_found", "Voice not found.", 404)
    return item


class VoiceDefaultsBody(BaseModel):
    language: Literal["en", "ja", "ko", "zh"]
    voice_id: str = Field(min_length=1, max_length=64)


@router.put("/voices/defaults")
def put_voice_defaults(
    request: Request,
    body: VoiceDefaultsBody,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[TtsClient, Depends(get_tts_client)],
) -> dict[str, Any]:
    """Set the server-wide default for one language; it must be an on-server
    voice whose (detected or assigned) language is that language."""
    require_csrf(request, request.state.session_row)
    voices = discover_voices(settings, client)
    if voice_languages(db, voices).get(body.voice_id) != body.language:
        raise ApiError(
            "validation_failed",
            f"{body.voice_id} is not a {body.language} voice on the server.",
            422,
        )
    defaults = load_voice_defaults(db)
    defaults[body.language] = body.voice_id
    save_voice_defaults(db, defaults)
    return {"defaults": effective_defaults(db, voices)}


@router.delete("/voices/{voice_id}", status_code=204)
def delete_voice(
    request: Request,
    voice_id: str,
    db: Annotated[DbSession, Depends(get_session)],
) -> None:
    """Forget a voice that is no longer on the server: drop its alias,
    language override, narration instruction and any default entry pointing at
    it. Idempotent."""
    require_csrf(request, request.state.session_row)
    names = load_overrides(db)
    names.pop(voice_id, None)
    save_overrides(db, names)
    languages = load_voice_languages(db)
    languages.pop(voice_id, None)
    save_voice_languages(db, languages)
    defaults = {k: v for k, v in load_voice_defaults(db).items() if v != voice_id}
    save_voice_defaults(db, defaults)
    voice_instructions = load_voice_instructions(db)
    voice_instructions.pop(voice_id, None)
    save_voice_instructions(db, voice_instructions)


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
