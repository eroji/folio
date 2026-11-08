"""Long-lived sessions: sliding cookies, and a periodic directory re-check that
ends the sessions of an account that was disabled, locked or removed."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from factories import make_session_row, make_user
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio.deps import ACCOUNT_CHECK_INTERVAL, get_account_checker
from folio.ldap_auth import AccountGone, DirectoryUnavailable
from folio.models import Session as SessionRow
from folio.models import User
from folio.security import SESSION_MAX_AGE

USER_GROUP = "cn=folio-user,dc=test"
ADMIN_GROUP = "cn=folio-admin,dc=test"


class FakeDirectory:
    """Stands in for Ldap3Authenticator.check: dn -> groups, or an exception."""

    def __init__(self) -> None:
        self.answer: list[str] | Exception = [USER_GROUP]
        self.calls: list[str] = []

    def check(self, dn: str) -> list[str]:
        self.calls.append(dn)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


@pytest.fixture()
def directory(client: httpx.AsyncClient) -> Iterator[FakeDirectory]:
    app: FastAPI = client._transport.app  # type: ignore[attr-defined]
    fake = FakeDirectory()
    app.dependency_overrides[get_account_checker] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_account_checker, None)


def _signed_in(client: httpx.AsyncClient, db: Session, *, checked_ago: timedelta | None) -> User:
    user = make_user(db, username="longlived")
    user.verified_at = None if checked_ago is None else datetime.now(UTC) - checked_ago
    row = make_session_row(db, user)
    make_session_row(db, user)  # a second device
    db.commit()
    client.cookies.set("folio_session", row.id, domain="testserver.local")
    return user


def _sessions(db: Session, user: User) -> int:
    db.expire_all()
    return (
        db.scalar(select(func.count()).select_from(SessionRow).where(SessionRow.user_id == user.id))
        or 0
    )


async def test_a_session_is_valid_well_past_30_days(client: httpx.AsyncClient, db: Session) -> None:
    assert SESSION_MAX_AGE >= timedelta(days=365)
    user = make_user(db, username="veteran")
    row = make_session_row(db, user)
    row.created_at = datetime.now(UTC) - timedelta(days=90)
    db.commit()
    client.cookies.set("folio_session", row.id, domain="testserver.local")
    assert (await client.get("/api/v1/auth/me")).status_code == 200


async def test_use_re_issues_both_cookies_so_the_browser_keeps_them(
    client: httpx.AsyncClient, db: Session
) -> None:
    """The row slid but the cookie kept its login-time Max-Age, so the browser
    dropped a perfectly valid session 30 days after login."""
    user = make_user(db, username="daily")
    row = make_session_row(db, user)
    row.expires_at = datetime.now(UTC) + SESSION_MAX_AGE - timedelta(days=3)
    db.commit()
    client.cookies.set("folio_session", row.id, domain="testserver.local")

    response = await client.get("/api/v1/me/settings")
    assert response.status_code == 200
    cookies = response.headers.get_list("set-cookie")
    lifetime = f"Max-Age={int(SESSION_MAX_AGE.total_seconds())}"
    session_cookie = next(h for h in cookies if h.startswith("folio_session="))
    assert session_cookie.startswith(f"folio_session={row.id};") and lifetime in session_cookie
    assert any(h.startswith("folio_csrf=") and lifetime in h for h in cookies)


async def test_an_account_checked_recently_is_not_looked_up_again(
    client: httpx.AsyncClient, db: Session, directory: FakeDirectory
) -> None:
    _signed_in(client, db, checked_ago=ACCOUNT_CHECK_INTERVAL / 2)
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert directory.calls == []


async def test_an_active_account_is_re_checked_and_keeps_its_session(
    client: httpx.AsyncClient, db: Session, directory: FakeDirectory
) -> None:
    user = _signed_in(client, db, checked_ago=ACCOUNT_CHECK_INTERVAL * 2)
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert directory.calls == [user.ldap_dn]
    db.expire_all()
    assert db.get(User, user.id).verified_at > datetime.now(UTC) - timedelta(minutes=1)  # type: ignore[union-attr]
    # …and is not looked up again on the next request.
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert len(directory.calls) == 1


@pytest.mark.parametrize(
    "answer", [AccountGone(), []], ids=["disabled-locked-or-deleted", "left-the-groups"]
)
async def test_a_gone_account_loses_every_session_at_once(
    client: httpx.AsyncClient, db: Session, directory: FakeDirectory, answer: object
) -> None:
    user = _signed_in(client, db, checked_ago=None)
    directory.answer = answer  # type: ignore[assignment]
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"
    assert _sessions(db, user) == 0  # the other device is signed out too


async def test_a_group_change_updates_the_role(
    client: httpx.AsyncClient, db: Session, directory: FakeDirectory
) -> None:
    user = _signed_in(client, db, checked_ago=None)
    directory.answer = [ADMIN_GROUP]
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "admin"
    db.expire_all()
    assert db.get(User, user.id).role == "admin"  # type: ignore[union-attr]


async def test_an_unreachable_directory_never_signs_anyone_out(
    client: httpx.AsyncClient, db: Session, directory: FakeDirectory
) -> None:
    user = _signed_in(client, db, checked_ago=None)
    directory.answer = DirectoryUnavailable()
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert _sessions(db, user) == 2
    # Retried within the hour, not on every request.
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert len(directory.calls) == 1


def test_test_mode_never_reaches_the_directory() -> None:
    from folio.config import get_settings

    assert get_settings().folio_test_mode
    assert get_account_checker(get_settings()) is None
