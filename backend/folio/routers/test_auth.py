"""Test-mode login: `POST /api/v1/test/login` seeds a user and creates a session
without LDAP. Mounted by create_app only when folio_test_mode is true; only
compose.test.yaml may enable it (docs/DECISIONS.md).
"""

from __future__ import annotations

import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.models import Session as SessionRow
from folio.models import User
from folio.security import set_csrf_cookie

router = APIRouter(prefix="/api/v1/test", tags=["test"])


class TestLoginBody(BaseModel):
    username: str = "testuser"
    role: Literal["user", "admin"] = "user"


@router.post("/login")
def test_login(
    body: TestLoginBody,
    response: Response,
    session: Annotated[DbSession, Depends(get_session)],
) -> dict[str, Any]:
    user = session.scalar(select(User).where(User.username == body.username))
    if user is None:
        user = User(
            ldap_dn=f"uid={body.username},dc=test",
            username=body.username,
            display_name=body.username.title(),
            email=f"{body.username}@test.invalid",
            role=body.role,
        )
        session.add(user)
        session.flush()
    user.role = body.role
    token = secrets.token_hex(32)
    # Same CSRF derivation as folio.security (Task 2): hmac(secret, session_id).
    csrf = hmac.new(get_settings().folio_secret_key.encode(), token.encode(), "sha256").hexdigest()
    session.add(
        SessionRow(
            id=token,
            user_id=user.id,
            csrf_token=csrf,
            user_agent="test-mode",
            expires_at=datetime.now(UTC) + timedelta(days=30),
        )
    )
    session.commit()
    response.set_cookie(
        "folio_session", token, httponly=True, secure=True, samesite="lax", max_age=30 * 86400
    )
    set_csrf_cookie(response, csrf)
    return {
        "user": {
            "id": str(user.id),
            "username": user.username,
            "display_name": user.display_name,
            "email": user.email,
            "role": user.role,
        },
        "csrf_token": csrf,
    }
