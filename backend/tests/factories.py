"""Object factories for tests: call with a session, get an uncommitted-or-flushed row."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from folio.models import Book, User
from folio.models import Session as SessionRow


def make_user(session: Session, *, username: str | None = None, role: str = "user") -> User:
    username = username or f"user-{uuid.uuid4().hex[:8]}"
    user = User(
        ldap_dn=f"uid={username},dc=test",
        username=username,
        display_name=username.title(),
        email=f"{username}@test.invalid",
        role=role,
    )
    session.add(user)
    session.flush()
    return user


def make_session_row(session: Session, user: User, *, csrf_token: str = "c" * 64) -> SessionRow:
    row = SessionRow(
        id=uuid.uuid4().hex,
        user_id=user.id,
        csrf_token=csrf_token,
        user_agent="pytest",
        expires_at=datetime.now(UTC) + timedelta(days=30),
    )
    session.add(row)
    session.flush()
    return row


def make_book(session: Session, **overrides: object) -> Book:
    book = Book(title=overrides.pop("title", "Fixture Book"), **overrides)  # type: ignore[arg-type]
    session.add(book)
    session.flush()
    return book
