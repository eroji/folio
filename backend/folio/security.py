"""Sessions, CSRF, and the login rate limiter (spec: Sessions and security)."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from time import monotonic

from fastapi import Request, Response
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.errors import ApiError
from folio.models import Session as SessionRow
from folio.models import User

SESSION_COOKIE = "folio_session"
CSRF_COOKIE = "folio_csrf"
SESSION_MAX_AGE = timedelta(days=30)
CSRF_HEADER = "X-CSRF-Token"


def new_session_id() -> str:
    """32 random bytes, hex-encoded: the session row PK and cookie value."""
    return secrets.token_hex(32)


def csrf_for(session_id: str, secret: str) -> str:
    """CSRF token = HMAC-SHA256(secret, session_id); same derivation as the
    test-mode login endpoint so fixtures stay valid."""
    return hmac.new(secret.encode(), session_id.encode(), hashlib.sha256).hexdigest()


def create_session(db: DbSession, user: User, user_agent: str | None) -> tuple[str, str]:
    """Insert a 30-day session row; caller commits. Returns (token, csrf)."""
    token = new_session_id()
    csrf = csrf_for(token, get_settings().folio_secret_key)
    db.add(
        SessionRow(
            id=token,
            user_id=user.id,
            csrf_token=csrf,
            user_agent=(user_agent or "")[:512] or None,
            expires_at=datetime.now(UTC) + SESSION_MAX_AGE,
        )
    )
    db.flush()
    return token, csrf


def set_session_cookies(response: Response, session_token: str, csrf_token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        max_age=int(SESSION_MAX_AGE.total_seconds()),
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )
    # Readable on purpose: the SPA echoes it in the X-CSRF-Token header.
    response.set_cookie(
        CSRF_COOKIE, csrf_token, httponly=False, secure=True, samesite="lax", path="/"
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


def require_csrf(request: Request, session_row: SessionRow) -> None:
    """Double-submit check for every state-changing request."""
    header = request.headers.get(CSRF_HEADER.lower(), "")
    if not secrets.compare_digest(header, session_row.csrf_token):
        raise ApiError("csrf_failed", "CSRF validation failed.", 403)


class LoginRateLimiter:
    """10 failures per username per 15 min -> 15 min lockout (in Folio, not AD).

    # ponytail: single-process limiter, move to a DB table if the API is ever
    # scaled past one uvicorn worker.
    """

    def __init__(self, max_failures: int = 10, window_s: float = 900.0, lockout_s: float = 900.0):
        self._max_failures = max_failures
        self._window_s = window_s
        self._lockout_s = lockout_s
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}

    def _prune(self, username: str, now: float) -> deque[float]:
        failures = self._failures[username]
        while failures and now - failures[0] > self._window_s:
            failures.popleft()
        return failures

    def locked_out(self, username: str) -> bool:
        now = monotonic()
        until = self._locked_until.get(username.lower(), 0.0)
        if until and now >= until:
            self._locked_until.pop(username.lower(), None)
            self._failures.pop(username.lower(), None)
            return False
        return now < until

    def record_failure(self, username: str) -> None:
        key = username.lower()
        now = monotonic()
        failures = self._prune(key, now)
        failures.append(now)
        if len(failures) >= self._max_failures:
            self._locked_until[key] = now + self._lockout_s
            failures.clear()

    def record_success(self, username: str) -> None:
        key = username.lower()
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)

    def reset(self) -> None:
        self._failures.clear()
        self._locked_until.clear()


login_rate_limiter = LoginRateLimiter()
