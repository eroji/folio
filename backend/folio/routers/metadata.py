"""Online metadata API: search providers, apply a candidate, list saved candidates.

All three routes are admin-or-uploader (they read or write another user's book
metadata); the apply route is the only mutation and requires CSRF. A provider
failure is "no results" (see ``metadata/__init__.get_json``), never a 500.
"""

import dataclasses
from collections.abc import Iterator
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.deps import can_edit_book, get_current_user
from folio.errors import ApiError
from folio.metadata import Candidate
from folio.metadata import service as metadata_service
from folio.metadata.match import score_candidate
from folio.metadata.service import genre_from_subjects, search_book
from folio.models import Book, MetadataCandidate, User
from folio.routers.books import _public
from folio.security import require_csrf
from folio.text import clean_description

router = APIRouter(prefix="/api/v1/books", tags=["metadata"])

_CANDIDATE_FIELDS = {f.name for f in dataclasses.fields(Candidate)}


def get_http_client() -> Iterator[httpx.Client]:
    """Sync client for provider searches; tests override with ``MockTransport``."""
    with httpx.Client(timeout=10.0, follow_redirects=True) as client:
        yield client


class ApplyBody(BaseModel):
    source: str = ""
    payload: dict[str, Any]
    fields: list[str] = Field(default_factory=list)


def _get_book(db: DbSession, book_id: UUID) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise ApiError("not_found", "Book not found.", 404)
    return book


def _require_edit(user: User, book: Book) -> None:
    if not can_edit_book(user, book):
        raise ApiError("forbidden", "You can only edit books you uploaded.", 403)


def _candidate_from_payload(payload: dict[str, Any], source: str) -> Candidate:
    """Rebuild a Candidate from the client's echoed search result, ignoring junk."""
    data = {key: value for key, value in payload.items() if key in _CANDIDATE_FIELDS}
    data["id"] = str(data.get("id", ""))
    data["source"] = str(data.get("source") or source)
    return Candidate(**data)


@router.get("/{book_id}/metadata/search")
def metadata_search(
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    http_client: Annotated[httpx.Client, Depends(get_http_client)],
    q: str | None = None,
    isbn: str | None = None,
) -> dict[str, Any]:
    book = _get_book(db, book_id)
    _require_edit(user, book)
    candidates = search_book(get_settings(), q, isbn, http_client)
    # Providers return their own relevance order; the UI shows a match
    # percentage, so score every candidate against this book (as auto_fetch does).
    for candidate in candidates:
        candidate.score = score_candidate(book, candidate)
    candidates.sort(key=lambda candidate: candidate.score, reverse=True)
    items = []
    for candidate in candidates:
        item = dataclasses.asdict(candidate)
        item["description"] = (
            clean_description(candidate.description) if candidate.description else None
        )
        # The drawer offers a Genre suggestion without duplicating the mapping.
        item["suggested_genre"] = genre_from_subjects(candidate.tags)
        # True when this provider cover is already the book's cover (set via
        # /cover-url): the drawer then shows no cover suggestion.
        item["cover_applied"] = bool(
            book.cover_key
            and book.cover_source_url
            and candidate.cover_url == book.cover_source_url
        )
        items.append(item)
    return {"items": items}


@router.post("/{book_id}/metadata/apply")
def metadata_apply(
    request: Request,
    book_id: UUID,
    body: ApplyBody,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    require_csrf(request, request.state.session_row)
    book = _get_book(db, book_id)
    _require_edit(user, book)
    candidate = _candidate_from_payload(body.payload, body.source)
    applied = metadata_service.apply_candidate(
        db, book, candidate, body.fields, get_settings(), respect_locks=False
    )
    # An explicit apply is a manual edit: lock what landed so a later automatic
    # fetch cannot overwrite it (covers are not a Book column).
    locked = [name for name in applied if name != "cover_url"]
    if locked:
        book.locked_fields = list(dict.fromkeys([*book.locked_fields, *locked]))
        db.commit()
    return {"book": _public(book, user), "applied": applied}


@router.get("/{book_id}/metadata/candidates")
def metadata_candidates(
    book_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    book = _get_book(db, book_id)
    _require_edit(user, book)
    rows = db.scalars(
        select(MetadataCandidate)
        .where(MetadataCandidate.book_id == book.id)
        .order_by(MetadataCandidate.score.desc(), MetadataCandidate.created_at)
    ).all()
    return {
        "items": [
            {
                "id": str(row.id),
                "source": row.source,
                "payload": row.payload,
                "score": row.score,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
    }
