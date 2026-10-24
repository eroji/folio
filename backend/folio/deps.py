"""Shared FastAPI dependencies: session validation, roles, edit permission."""

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.errors import ApiError
from folio.ldap_auth import Ldap3Authenticator, LdapAuthenticator
from folio.models import Book, User
from folio.models import Session as SessionRow
from folio.security import SESSION_COOKIE, SESSION_MAX_AGE

EXPIRED_MESSAGE = "Authentication required."
# Sliding expiry is refreshed at most once per hour to keep writes off hot paths.
REFRESH_INTERVAL = timedelta(hours=1)

_authenticator: LdapAuthenticator | None = None


def get_authenticator() -> LdapAuthenticator:
    """Directory connection singleton; overridden via app.dependency_overrides."""
    global _authenticator
    if _authenticator is None:
        _authenticator = Ldap3Authenticator(get_settings())
    return _authenticator


def get_current_user(request: Request, db: Annotated[DbSession, Depends(get_session)]) -> User:
    token = request.cookies.get(SESSION_COOKIE, "")
    if not token or len(token) > 64:
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401)
    row = db.get(SessionRow, token)
    if row is None:
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401)
    now = datetime.now(UTC)
    if row.expires_at <= now:
        db.delete(row)
        db.commit()
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401)
    if row.expires_at < now + SESSION_MAX_AGE - REFRESH_INTERVAL:
        row.expires_at = now + SESSION_MAX_AGE  # sliding expiry
        db.commit()
    user = db.get(User, row.user_id)
    if user is None:  # defensive: FK cascade should make this impossible
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401)
    request.state.session_row = row
    return user


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise ApiError("forbidden", "Admin access required.", 403)
    return user


def can_edit_book(user: User, book: Book) -> bool:
    """Admins edit any book; everyone else only their own uploads."""
    return user.role == "admin" or book.uploaded_by == user.id
