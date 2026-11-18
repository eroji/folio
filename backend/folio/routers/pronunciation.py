"""Pronunciation rules API: per-book text substitutions (spec: TTS → Text preparation).

GET lists, POST creates, PATCH/DELETE mutate one rule. Any change to an
accepted rule drops the book's segment_audio rows so the next prepare re-queues
with corrected text. Suggested rules (from the language model, POST /suggest)
change nothing until accepted (PATCH ``suggested: false``); editing or
dismissing one leaves the audio alone.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import can_edit_book, get_current_user
from folio.errors import ApiError
from folio.integrations import load_integrations
from folio.jobs import enqueue, notify
from folio.models import Book, Job, PronunciationRule, User
from folio.security import require_csrf
from folio.tts.queue import invalidate_book_audio

router = APIRouter(prefix="/api/v1/books/{book_id}/pronunciation", tags=["books"])


class RuleCreate(BaseModel):
    match: str = Field(min_length=1, max_length=200)
    say: str = Field(min_length=1, max_length=200)
    whole_word: bool = False
    after_number: bool = False
    case_sensitive: bool = False


class RulePatch(BaseModel):
    """PATCH body: every field optional; provided ones are validated."""

    match: str | None = Field(default=None, min_length=1, max_length=200)
    say: str | None = Field(default=None, min_length=1, max_length=200)
    whole_word: bool | None = None
    after_number: bool | None = None
    case_sensitive: bool | None = None
    # false accepts a suggestion (a rule cannot be turned back into one).
    suggested: bool | None = None


def _dict(rule: PronunciationRule) -> dict[str, Any]:
    return {
        "id": str(rule.id),
        "match": rule.match,
        "say": rule.say,
        "whole_word": rule.whole_word,
        "after_number": rule.after_number,
        "case_sensitive": rule.case_sensitive,
        "suggested": rule.suggested,
    }


def _clean(value: str | None) -> str:
    """Trim; whitespace-only is empty and rejected like a missing one."""
    cleaned = (value or "").strip()
    if not cleaned:
        raise ApiError("validation_failed", "Rule text must not be empty.", 422)
    return cleaned


def _get_book(db: DbSession, book_id: UUID, user: User) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only edit books you uploaded.", 403)
    return book


def _reject_duplicate(db: DbSession, book: Book, match: str, rule_id: UUID | None = None) -> None:
    stmt = select(PronunciationRule.id).where(
        PronunciationRule.book_id == book.id,
        PronunciationRule.suggested.is_(False),  # a suggestion gives way to a rule
        func.lower(PronunciationRule.match) == match.lower(),
    )
    if rule_id is not None:
        stmt = stmt.where(PronunciationRule.id != rule_id)
    if db.scalar(stmt) is not None:
        raise ApiError("validation_failed", "A rule for this match already exists.", 422)


def _drop_suggestion(db: DbSession, book: Book, match: str) -> None:
    for rule in db.scalars(
        select(PronunciationRule).where(
            PronunciationRule.book_id == book.id,
            PronunciationRule.suggested.is_(True),
            func.lower(PronunciationRule.match) == match.lower(),
        )
    ):
        db.delete(rule)


@router.get("")
def list_rules(
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    book = _get_book(db, book_id, user)
    rules = db.scalars(
        select(PronunciationRule)
        .where(PronunciationRule.book_id == book.id)
        .order_by(PronunciationRule.created_at, PronunciationRule.id)
    ).all()
    model = load_integrations(db).language_model
    return {
        "items": [_dict(r) for r in rules],
        # The language model can suggest rules (and the delivery note).
        "can_suggest": model.configured,
        "suggesting": _pending_suggest(db, book.id) is not None,
        # Whether the engine receives style prompts (voice + delivery notes) at all.
        "style_prompts": settings.tts_instructions,
    }


def _pending_suggest(db: DbSession, book_id: UUID) -> Job | None:
    return db.scalar(
        select(Job).where(
            Job.book_id == book_id, Job.type == "suggest", Job.status.in_(("queued", "running"))
        )
    )


@router.post("/suggest", status_code=202)
def suggest_rules(
    request: Request,
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    """Ask the language model for rules and a delivery note (a background job)."""
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id, user)
    if not load_integrations(db).language_model.configured:
        raise ApiError(
            "language_model_off", "Set up a language model under Admin → Integrations first.", 409
        )
    job = _pending_suggest(db, book.id) or enqueue(db, "suggest", book.id, user_id=user.id)
    db.commit()
    notify(
        db, {"event": "job", "job_id": str(job.id), "book_id": str(book.id), "status": job.status}
    )
    return {"job_id": str(job.id)}


@router.post("")
def create_rule(
    request: Request,
    book_id: UUID,
    body: RuleCreate,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id, user)
    match, say = _clean(body.match), _clean(body.say)
    _reject_duplicate(db, book, match)
    _drop_suggestion(db, book, match)
    rule = PronunciationRule(
        book_id=book.id,
        match=match,
        say=say,
        whole_word=body.whole_word,
        after_number=body.after_number,
        case_sensitive=body.case_sensitive,
    )
    db.add(rule)
    db.commit()
    invalidate_book_audio(db, book.id)
    return {"rule": _dict(rule)}


@router.patch("/{rule_id}")
def patch_rule(
    request: Request,
    book_id: UUID,
    rule_id: UUID,
    body: RulePatch,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id, user)
    rule = db.get(PronunciationRule, rule_id)
    if rule is None or rule.book_id != book.id:
        raise ApiError("not_found", "Rule not found.", 404)
    match = _clean(body.match) if body.match is not None else rule.match
    if body.say is not None:
        rule.say = _clean(body.say)
    if body.match is not None and match.lower() != rule.match.lower():
        _reject_duplicate(db, book, match, rule_id=rule.id)
    rule.match = match
    for name in ("whole_word", "after_number", "case_sensitive"):
        value = getattr(body, name)
        if value is not None:
            setattr(rule, name, value)
    if body.suggested is False and rule.suggested:
        _reject_duplicate(db, book, rule.match, rule_id=rule.id)
        rule.suggested = False  # accepted: from now on it shapes the speech
    db.commit()
    if not rule.suggested:
        invalidate_book_audio(db, book.id)
    return {"rule": _dict(rule)}


@router.delete("/{rule_id}", status_code=204)
def delete_rule(
    request: Request,
    book_id: UUID,
    rule_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> None:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id, user)
    rule = db.get(PronunciationRule, rule_id)
    if rule is None or rule.book_id != book.id:
        raise ApiError("not_found", "Rule not found.", 404)
    was_applied = not rule.suggested
    db.delete(rule)
    db.commit()
    if was_applied:  # dismissing a suggestion leaves the audio alone
        invalidate_book_audio(db, book.id)
