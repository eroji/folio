"""Auth endpoints: LDAP login, logout, and the current-user bootstrap."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from folio.config import Settings, get_settings
from folio.db import get_session
from folio.deps import get_authenticator, get_current_user
from folio.errors import ApiError
from folio.ldap_auth import InvalidCredentials, LdapAuthenticator, NotAllowed, role_from_groups
from folio.models import User
from folio.security import (
    clear_session_cookies,
    create_session,
    login_rate_limiter,
    require_csrf,
    set_csrf_cookie,
    set_session_cookies,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=1024)


class UserPublic(BaseModel):
    model_config = {"from_attributes": True}

    id: UUID
    username: str
    display_name: str
    email: str | None
    role: str


@router.get("/options")
def options(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, bool]:
    """Unauthenticated capability probe for the login page (no secrets)."""
    return {"test_mode": settings.folio_test_mode}


@router.post("/login")
def login(
    request: Request,
    response: Response,
    body: LoginBody,
    db: Annotated[DbSession, Depends(get_session)],
    authenticator: Annotated[LdapAuthenticator, Depends(get_authenticator)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    if login_rate_limiter.locked_out(body.username):
        raise ApiError("locked_out", "Too many failed attempts. Try again in 15 minutes.", 429)
    try:
        ldap_user = authenticator.authenticate(body.username, body.password)
    except InvalidCredentials:
        login_rate_limiter.record_failure(body.username)
        logger.info("login failed user=%s reason=invalid_credentials", body.username)
        raise ApiError("invalid_credentials", "Invalid username or password", 401)
    except NotAllowed:
        login_rate_limiter.record_failure(body.username)
        logger.info("login failed user=%s reason=not_allowed", body.username)
        raise ApiError("not_allowed", "Your account is not allowed to use Folio", 403)
    role = role_from_groups(ldap_user.groups, settings)
    if role is None:
        logger.info("login failed user=%s reason=not_allowed", body.username)
        raise ApiError("not_allowed", "Your account is not allowed to use Folio", 403)

    user = db.scalar(select(User).where(User.username == ldap_user.username))
    if user is None:
        user = User(ldap_dn=ldap_user.dn, username=ldap_user.username, role=role)
        db.add(user)
        db.flush()
    user.ldap_dn = ldap_user.dn
    user.display_name = ldap_user.display_name
    user.email = ldap_user.email or None
    user.role = role  # roles come from the directory at every login (spec)
    user.last_login_at = datetime.now(UTC)
    token, csrf = create_session(db, user, request.headers.get("user-agent"))
    db.commit()
    login_rate_limiter.record_success(body.username)
    set_session_cookies(response, token, csrf)
    return {"user": UserPublic.model_validate(user), "csrf_token": csrf}


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
) -> dict[str, bool]:
    require_csrf(request, request.state.session_row)
    db.delete(request.state.session_row)
    db.commit()
    clear_session_cookies(response)
    return {"ok": True}


@router.get("/me")
def me(
    request: Request, response: Response, user: Annotated[User, Depends(get_current_user)]
) -> dict[str, Any]:
    row: Any = request.state.session_row
    # The app calls /me on every launch: re-issue the CSRF cookie so a device
    # that lost it (or got it before it persisted) can write again.
    set_csrf_cookie(response, row.csrf_token)
    return {"user": UserPublic.model_validate(user), "csrf_token": row.csrf_token}
