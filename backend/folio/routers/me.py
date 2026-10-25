"""/me: Continue listening list and per-user listening settings (spec M5)."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError
from folio.models import Book, Progress, User
from folio.routers.books import _public
from folio.routers.progress import progress_dict
from folio.security import require_csrf

router = APIRouter(prefix="/api/v1/me", tags=["me"])

# Storage starts empty; these are what a fresh user gets (spec: listening settings).
DEFAULT_SETTINGS: dict[str, Any] = {
    "speed": 1.0,
    "voices": {},
    "skip_back": 15,
    "skip_forward": 30,
    "auto_next": True,
    "speak_titles": True,
}


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float | None = None
    voices: dict[str, str] | None = None
    skip_back: int | None = None
    skip_forward: int | None = None
    auto_next: bool | None = None
    speak_titles: bool | None = None


def _fail() -> None:
    raise ApiError("validation_failed", "Invalid request", 422)


def _merge(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """One level deep: nested dicts (voices) merge by key, everything replaces."""
    merged = dict(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def _validated(patch: SettingsPatch) -> dict[str, Any]:
    values: dict[str, Any] = {}
    if patch.speed is not None:
        # 0.75-2.5 in 0.25 steps; quarters are exact in binary, round guards drift.
        if not 0.75 <= patch.speed <= 2.5 or round(patch.speed * 100) % 25:
            _fail()
        values["speed"] = patch.speed
    for name in ("skip_back", "skip_forward"):
        value = getattr(patch, name)
        if value is not None:
            if not 5 <= value <= 120:
                _fail()
            values[name] = value
    if patch.voices is not None:
        if not all(
            language and isinstance(voice, str) and voice.strip()
            for language, voice in patch.voices.items()
        ):
            _fail()
        values["voices"] = patch.voices
    for name in ("auto_next", "speak_titles"):
        value = getattr(patch, name)
        if value is not None:
            values[name] = value
    return values


@router.get("/continue")
def continue_listening(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    rows = db.execute(
        select(Progress, Book)
        .join(Book, Book.id == Progress.book_id)
        .where(Progress.user_id == user.id, Progress.finished_at.is_(None))
        .order_by(Progress.updated_at.desc())
        .limit(limit)
    ).all()
    return {
        "items": [
            {"book": _public(book, user), "progress": progress_dict(row)} for row, book in rows
        ]
    }


@router.get("/finished")
def finished_list(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    """Finished shelf: same shape as /me/continue, newest finish first."""
    rows = db.execute(
        select(Progress, Book)
        .join(Book, Book.id == Progress.book_id)
        .where(Progress.user_id == user.id, Progress.finished_at.is_not(None))
        .order_by(Progress.finished_at.desc())
        .limit(limit)
    ).all()
    return {
        "items": [
            {"book": _public(book, user), "progress": progress_dict(row)} for row, book in rows
        ]
    }


@router.get("/settings")
def get_listening_settings(user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    return {"settings": _merge(DEFAULT_SETTINGS, user.settings)}


@router.put("/settings")
def put_settings(
    request: Request,
    patch: SettingsPatch,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    values = _validated(patch)
    # Rebind (not mutate) so SQLAlchemy flags the JSONB column as changed.
    user.settings = _merge(user.settings, values)
    db.commit()
    return {"settings": _merge(DEFAULT_SETTINGS, user.settings)}
