"""/me: Home shelves, Continue listening and per-user listening settings (spec M5, handoff §5)."""

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError
from folio.models import Book, Chapter, Progress, User
from folio.routers.books import _public
from folio.routers.progress import progress_dict
from folio.security import require_csrf
from folio.voice_catalog import base_language

router = APIRouter(prefix="/api/v1/me", tags=["me"])

# Storage starts empty; these are what a fresh user gets (spec: listening settings).
# Direction D removed theme: the app is dark only (stale rows are stripped, see below).
DEFAULT_SETTINGS: dict[str, Any] = {
    "speed": 1.0,
    "voices": {},
    "skip_back": 15,
    "skip_forward": 30,
    "auto_next": True,
    "speak_titles": True,
}

HOME_SHELF_SIZE = 12


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float | None = None
    voices: dict[str, str | None] | None = None  # base language -> voice id, null = server default
    skip_back: int | None = None
    skip_forward: int | None = None
    auto_next: bool | None = None
    speak_titles: bool | None = None
    theme: str | None = None  # accepted and ignored: old clients still send it


def _fail() -> None:
    raise ApiError("validation_failed", "Invalid request", 422)


def _included_number(db: DbSession, book_id: UUID, idx: int) -> int:
    """1-based position of ``idx`` among the book's included chapters, so the
    Home cards match the book page's 1..N numbering even after exclusions."""
    return (
        db.scalar(
            select(func.count())
            .select_from(Chapter)
            .where(Chapter.book_id == book_id, Chapter.excluded.is_(False), Chapter.idx <= idx)
        )
        or 0
    )


def _merge(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """One level deep: nested dicts (voices) merge by key, everything replaces."""
    merged = dict(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def _normalize_voices(raw: Any) -> dict[str, Any]:
    """Fold legacy region keys to base languages (``zh-TW`` -> ``zh``, ``kr`` -> ``ko``);
    an exact base-language entry wins over a variant when both are stored."""
    out: dict[str, Any] = {}
    for language, voice in (raw or {}).items():
        base = _voice_key(language)
        if not base or (base in out and str(language).lower() != base):
            continue
        out[base] = voice
    return out


def _voice_key(language: str) -> str:
    """Storage key for a settings voices map: base language, or the lower-cased
    key for languages outside the four the UI offers (``de`` stays ``de``)."""
    return base_language(language) or str(language).strip().lower()


def _public_settings(user: User) -> dict[str, Any]:
    merged = _merge(DEFAULT_SETTINGS, user.settings)
    merged.pop("theme", None)  # Direction D: dark only; stale rows are never returned
    merged["voices"] = _normalize_voices(merged.get("voices"))
    return merged


def _validated(patch: SettingsPatch) -> dict[str, Any]:
    values: dict[str, Any] = {}
    if patch.speed is not None:
        # 0.9-1.15 in 0.05 steps; round guards the binary drift in 1.15.
        if not 0.9 <= patch.speed <= 1.15 or round(patch.speed * 100) % 5:
            _fail()
        values["speed"] = patch.speed
    for name in ("skip_back", "skip_forward"):
        value = getattr(patch, name)
        if value is not None:
            if not 5 <= value <= 120:
                _fail()
            values[name] = value
    if patch.voices is not None:
        normalized: dict[str, Any] = {}
        for language, voice in patch.voices.items():
            base = _voice_key(language)
            if not base:
                _fail()
            if voice is not None and not (isinstance(voice, str) and voice.strip()):
                _fail()
            if base in normalized and str(language).lower() != base:
                continue  # an explicit zh entry wins over a zh-TW one
            pinned: str | None = voice.strip() if isinstance(voice, str) else None
            if pinned is not None and len(pinned) > 64:
                _fail()
            normalized[base] = pinned
        values["voices"] = normalized
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


@router.get("/home")
def home(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    status: Literal["in_progress", "not_started", "finished"] | None = None,
    language: str | None = None,
    max_minutes: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    """Home shelves (Direction D §5.3): continue, next_chapters, recent.

    The chip filters map onto the shelves: ``status`` only ever matches
    ``in_progress`` for the continue/next shelves (they are in-progress by
    definition), language and max_minutes apply everywhere.
    """
    cps = get_settings().tts_chars_per_second
    book_filters = []
    if language:
        book_filters.append(Book.language == language)
    if max_minutes:
        book_filters.append(Book.est_duration_s <= max_minutes * 60)

    rows: list[tuple[Progress, Book]] = []
    if status in (None, "in_progress"):
        rows = [
            (row, book)
            for row, book in db.execute(
                select(Progress, Book)
                .join(Book, Book.id == Progress.book_id)
                .where(
                    Progress.user_id == user.id,
                    Progress.finished_at.is_(None),
                    *book_filters,
                )
                .order_by(Progress.updated_at.desc())
                .limit(HOME_SHELF_SIZE)
            ).all()
        ]

    continue_items: list[dict[str, Any]] = []
    next_items: list[dict[str, Any]] = []
    for row, book in rows:
        chapter = db.get(Chapter, row.chapter_id)
        continue_items.append(
            {
                "book": _public(book, user),
                "progress": progress_dict(row),
                "chapter": (
                    None
                    if chapter is None
                    else {
                        "id": str(chapter.id),
                        "idx": chapter.idx,
                        "number": _included_number(db, book.id, chapter.idx),
                        "title": chapter.title,
                    }
                ),
                "time_left_s": max(0.0, book.est_duration_s * (1 - row.percent / 100)),
            }
        )
        if chapter is not None:
            nxt = db.scalar(
                select(Chapter)
                .where(
                    Chapter.book_id == book.id,
                    Chapter.idx > chapter.idx,
                    Chapter.excluded.is_(False),
                )
                .order_by(Chapter.idx)
            )
            if nxt is not None:
                next_items.append(
                    {
                        "book": _public(book, user),
                        "chapter": {
                            "id": str(nxt.id),
                            "idx": nxt.idx,
                            "number": _included_number(db, book.id, nxt.idx),
                            "title": nxt.title,
                            "duration_s": nxt.char_count / cps,
                        },
                    }
                )

    recent_stmt = select(Book).where(*book_filters)
    progress_join = (Progress.book_id == Book.id) & (Progress.user_id == user.id)
    if status == "in_progress":
        recent_stmt = recent_stmt.join(Progress, progress_join).where(
            Progress.finished_at.is_(None), Progress.percent > 0
        )
    elif status == "finished":
        recent_stmt = recent_stmt.join(Progress, progress_join).where(
            Progress.finished_at.is_not(None)
        )
    elif status == "not_started":
        recent_stmt = recent_stmt.outerjoin(Progress, progress_join).where(
            or_(
                Progress.book_id.is_(None),
                Progress.finished_at.is_(None) & (Progress.percent <= 0),
            )
        )
    recent = db.scalars(
        recent_stmt.order_by(Book.created_at.desc(), Book.id).limit(HOME_SHELF_SIZE)
    )
    return {
        "continue": continue_items,
        "next_chapters": next_items,
        "recent": [_public(b, user) for b in recent],
    }


@router.get("/settings")
def get_listening_settings(user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    return {"settings": _public_settings(user)}


@router.put("/settings")
def put_settings(
    request: Request,
    patch: SettingsPatch,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    values = _validated(patch)
    # Rebind (not mutate) so SQLAlchemy flags the JSONB column as changed;
    # the comprehension also drops a theme left over from pre-Direction-D rows.
    user.settings = {
        key: value for key, value in _merge(user.settings, values).items() if key != "theme"
    }
    db.commit()
    return {"settings": _public_settings(user)}
