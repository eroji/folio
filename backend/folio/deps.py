"""Shared FastAPI dependencies: session validation, roles, edit permission."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlalchemy import delete
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.errors import ApiError
from folio.ldap_auth import (
    AccountDirectory,
    AccountGone,
    DirectoryUnavailable,
    Ldap3Authenticator,
    LdapAuthenticator,
    role_from_groups,
)
from folio.models import Book, User
from folio.models import Session as SessionRow
from folio.security import SESSION_COOKIE, SESSION_MAX_AGE, set_session_cookies

logger = logging.getLogger(__name__)

EXPIRED_MESSAGE = "Authentication required."
# Sliding expiry is refreshed at most once per hour to keep writes off hot paths.
REFRESH_INTERVAL = timedelta(hours=1)
# How stale the directory's word on an account may get before a request asks
# again: a disabled or locked account is signed out within this long.
ACCOUNT_CHECK_INTERVAL = timedelta(hours=1)

_authenticator: LdapAuthenticator | None = None


def get_authenticator() -> LdapAuthenticator:
    """Directory connection singleton; overridden via app.dependency_overrides."""
    global _authenticator
    if _authenticator is None:
        _authenticator = Ldap3Authenticator(get_settings())
    return _authenticator


def get_account_checker(
    settings: Annotated[Settings, Depends(get_settings)],
) -> AccountDirectory | None:
    """The directory that re-checks signed-in accounts; none in test mode,
    whose users never came from LDAP."""
    if settings.folio_test_mode:
        return None
    authenticator = get_authenticator()
    return authenticator if isinstance(authenticator, Ldap3Authenticator) else None


def get_current_user(
    request: Request,
    response: Response,
    db: Annotated[DbSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    directory: Annotated[AccountDirectory | None, Depends(get_account_checker)],
) -> User:
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
    user = db.get(User, row.user_id)
    if user is None:  # defensive: FK cascade should make this impossible
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401)
    if directory is not None and (
        user.verified_at is None or user.verified_at < now - ACCOUNT_CHECK_INTERVAL
    ):
        _recheck_account(db, user, directory, settings, now)
    if row.expires_at < now + SESSION_MAX_AGE - REFRESH_INTERVAL:
        row.expires_at = now + SESSION_MAX_AGE  # sliding expiry
        db.commit()
        # The cookie slides too: the browser otherwise drops it at the
        # login-time Max-Age while the row is still valid.
        set_session_cookies(response, row.id, row.csrf_token)
    request.state.session_row = row
    return user


def _recheck_account(
    db: DbSession, user: User, directory: AccountDirectory, settings: Settings, now: datetime
) -> None:
    """Ask the directory whether the account may still use Folio. A gone account
    loses every session (all devices); an unreachable directory signs no one
    out and is asked again after REFRESH_INTERVAL."""
    try:
        role = role_from_groups(directory.check(user.ldap_dn), settings)
        if role is None:
            raise AccountGone
    except AccountGone:
        logger.info("session ended user=%s reason=account_inactive", user.username)
        db.execute(delete(SessionRow).where(SessionRow.user_id == user.id))
        db.commit()
        raise ApiError("unauthenticated", EXPIRED_MESSAGE, 401) from None
    except DirectoryUnavailable:
        user.verified_at = now - ACCOUNT_CHECK_INTERVAL + REFRESH_INTERVAL
        db.commit()
        return
    user.role = role  # roles follow the directory, not only at login
    user.verified_at = now
    db.commit()


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise ApiError("forbidden", "Admin access required.", 403)
    return user


def can_edit_book(user: User, book: Book) -> bool:
    """Admins edit any book; everyone else only their own uploads."""
    return user.role == "admin" or book.uploaded_by == user.id
