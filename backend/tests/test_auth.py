"""Auth API: LDAP login (fake authenticator), server-side sessions, CSRF, roles."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from factories import make_book, make_session_row, make_user
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.deps import can_edit_book, get_authenticator
from folio.ldap_auth import InvalidCredentials, LdapUser, NotAllowed
from folio.models import Job
from folio.models import Session as SessionRow
from folio.security import SESSION_MAX_AGE, csrf_for, login_rate_limiter


class FakeAuthenticator:
    """Directory stand-in: users maps username -> (password, groups)."""

    def __init__(self) -> None:
        self.users: dict[str, tuple[str, list[str]]] = {"alice": ("pw", ["cn=folio-user,dc=test"])}
        self.calls: list[str] = []

    def authenticate(self, username: str, password: str) -> LdapUser:
        self.calls.append(username)
        found = self.users.get(username.lower())
        if found is None or found[0] != password:
            raise InvalidCredentials
        return LdapUser(
            dn=f"CN={username},DC=test",
            username=username.lower(),
            display_name=username.title(),
            email=f"{username}@test.invalid",
            groups=list(found[1]),
        )


class RaisingAuthenticator:
    """Authenticator that itself refuses outsiders, per the protocol contract."""

    def authenticate(self, username: str, password: str) -> LdapUser:
        raise NotAllowed


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> None:
    login_rate_limiter.reset()


@pytest.fixture()
def ldap(client: httpx.AsyncClient) -> FakeAuthenticator:
    app: FastAPI = client._transport.app  # type: ignore[attr-defined]
    fake = FakeAuthenticator()
    app.dependency_overrides[get_authenticator] = lambda: fake
    return fake


def _session_row(db: Session, token: str) -> SessionRow | None:
    return db.get(SessionRow, token)


def _cookie(client: httpx.AsyncClient, name: str) -> str:
    """httpx stores host-only cookies under <host>.local; read the jar directly."""
    return next(c.value for c in client.cookies.jar if c.name == name)


async def test_login_success_sets_cookies_and_creates_session_row(
    client: httpx.AsyncClient, db: Session, ldap: FakeAuthenticator, settings: Settings
) -> None:
    response = await client.post("/api/v1/auth/login", json={"username": "alice", "password": "pw"})
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["username"] == "alice"
    assert body["user"]["role"] == "user"
    token = response.cookies.get("folio_session")
    assert token and body["csrf_token"] == csrf_for(token, settings.folio_secret_key)

    set_headers = response.headers.get_list("set-cookie")
    session_cookie = next(h for h in set_headers if h.startswith("folio_session="))
    csrf_cookie = next(h for h in set_headers if h.startswith("folio_csrf="))
    assert "HttpOnly" in session_cookie and "Secure" in session_cookie
    assert "samesite=lax" in session_cookie.lower()
    assert "HttpOnly" not in csrf_cookie  # the SPA must read it
    # Both persist for the session lifetime: a browser-session CSRF cookie was
    # dropped when iOS relaunched the PWA, and every POST/PUT then got a 403.
    lifetime = f"Max-Age={int(SESSION_MAX_AGE.total_seconds())}"
    assert lifetime in session_cookie
    assert lifetime in csrf_cookie

    row = _session_row(db, token)
    assert row is not None and str(row.user_id) == body["user"]["id"]
    assert row.expires_at > datetime.now(UTC) + SESSION_MAX_AGE - timedelta(days=1)

    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 200 and me.json()["user"]["username"] == "alice"


async def test_login_upserts_user_and_updates_last_login(
    client: httpx.AsyncClient, db: Session, ldap: FakeAuthenticator
) -> None:
    from folio.models import User

    for _ in range(2):
        assert (
            await client.post("/api/v1/auth/login", json={"username": "alice", "password": "pw"})
        ).status_code == 200
    users = db.scalars(select(User).where(User.username == "alice")).all()
    assert len(users) == 1
    assert users[0].last_login_at is not None


async def test_login_wrong_password(client: httpx.AsyncClient, ldap: FakeAuthenticator) -> None:
    response = await client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "nope"}
    )
    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "invalid_credentials",
        "message": "Invalid username or password",
    }


async def test_login_outsider_is_refused(
    client: httpx.AsyncClient, ldap: FakeAuthenticator
) -> None:
    ldap.users["bob"] = ("pw", ["cn=strangers,dc=test"])
    response = await client.post("/api/v1/auth/login", json={"username": "bob", "password": "pw"})
    assert response.status_code == 403
    assert response.json()["error"] == {
        "code": "not_allowed",
        "message": "Your account is not allowed to use Folio",
    }


async def test_login_authenticator_not_allowed_maps_to_403(
    client: httpx.AsyncClient,
) -> None:
    app: FastAPI = client._transport.app  # type: ignore[attr-defined]
    app.dependency_overrides[get_authenticator] = lambda: RaisingAuthenticator()
    response = await client.post("/api/v1/auth/login", json={"username": "x", "password": "y"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "not_allowed"


async def test_nested_group_dn_resolves_role(
    client: httpx.AsyncClient, db: Session, ldap: FakeAuthenticator
) -> None:
    # The directory returns the group DN in a different case, as resolved
    # through LDAP_MATCHING_RULE_IN_CHAIN; role mapping is case-insensitive.
    ldap.users["carol"] = ("pw", ["CN=FOLIO-USER,DC=TEST"])
    response = await client.post("/api/v1/auth/login", json={"username": "carol", "password": "pw"})
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "user"


async def test_admin_group_dn_resolves_admin_role(
    client: httpx.AsyncClient, ldap: FakeAuthenticator
) -> None:
    ldap.users["root"] = ("pw", ["CN=Folio-Admin,DC=Test"])
    response = await client.post("/api/v1/auth/login", json={"username": "root", "password": "pw"})
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "admin"


async def test_eleventh_failed_attempt_locks_out_for_15_minutes(
    client: httpx.AsyncClient, ldap: FakeAuthenticator
) -> None:
    for _ in range(10):
        bad = await client.post("/api/v1/auth/login", json={"username": "alice", "password": "bad"})
        assert bad.status_code == 401
    ok = await client.post("/api/v1/auth/login", json={"username": "alice", "password": "pw"})
    assert ok.status_code == 429
    assert ok.json()["error"]["code"] == "locked_out"
    assert ldap.calls == ["alice"] * 10  # the 11th attempt never hits the directory
    # A different username is unaffected.
    ldap.users["dave"] = ("pw", ["cn=folio-user,dc=test"])
    other = await client.post("/api/v1/auth/login", json={"username": "dave", "password": "pw"})
    assert other.status_code == 200


async def test_lockout_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1_000_000.0]
    monkeypatch.setattr("folio.security.monotonic", lambda: now[0])
    limiter = type(login_rate_limiter)()
    for _ in range(10):
        limiter.record_failure("alice")
    assert limiter.locked_out("alice")
    now[0] += 15 * 60 + 1
    assert not limiter.locked_out("alice")


async def test_failures_older_than_the_window_do_not_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [1_000_000.0]
    monkeypatch.setattr("folio.security.monotonic", lambda: now[0])
    limiter = type(login_rate_limiter)()
    for _ in range(10):
        limiter.record_failure("erin")
    now[0] += 15 * 60 + 1
    assert not limiter.locked_out("erin")
    limiter.record_failure("erin")  # one fresh failure, window restarted
    assert not limiter.locked_out("erin")


async def test_logout_requires_csrf_and_deletes_the_session(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    token = _cookie(auth_client, "folio_session")
    csrf = _cookie(auth_client, "folio_csrf")
    assert token and csrf

    bad = await auth_client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "wrong"})
    assert bad.status_code == 403
    assert bad.json()["error"]["code"] == "csrf_failed"
    assert _session_row(db, token) is not None

    ok = await auth_client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    assert ok.status_code == 200
    assert _session_row(db, token) is None
    me = await auth_client.get("/api/v1/auth/me")
    assert me.status_code == 401


async def test_me_without_a_session_is_unauthenticated(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_expired_session_is_rejected(client: httpx.AsyncClient, db: Session) -> None:
    user = make_user(db)
    row = make_session_row(db, user)
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db.commit()
    client.cookies.set("folio_session", row.id, domain="testserver.local")
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_sliding_expiry_refreshes_at_most_hourly(
    client: httpx.AsyncClient, db: Session
) -> None:
    def expiry(row_id: str) -> datetime:
        db.expire_all()
        fresh = db.get(SessionRow, row_id)
        assert fresh is not None
        return fresh.expires_at

    # Last refreshed 2 days ago -> must be pushed out to the full lifetime.
    stale_user = make_user(db, username="stale")
    stale = make_session_row(db, stale_user)
    stale.expires_at = datetime.now(UTC) + SESSION_MAX_AGE - timedelta(days=2)
    db.commit()
    client.cookies.set("folio_session", stale.id, domain="testserver.local")
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert expiry(stale.id) > datetime.now(UTC) + SESSION_MAX_AGE - timedelta(days=1)

    # Refreshed 30 minutes ago -> must stay put (at most once per hour).
    fresh_user = make_user(db, username="fresh")
    fresh = make_session_row(db, fresh_user)
    target = datetime.now(UTC) + SESSION_MAX_AGE - timedelta(minutes=30)
    fresh.expires_at = target
    db.commit()
    client.cookies.set("folio_session", fresh.id, domain="testserver.local")
    assert (await client.get("/api/v1/auth/me")).status_code == 200
    assert abs((expiry(fresh.id) - target).total_seconds()) < 2


async def test_garbage_session_cookie_is_unauthenticated(client: httpx.AsyncClient) -> None:
    # The old admin_health stub only checked cookie presence; it must now validate.
    client.cookies.set("folio_session", "deadbeef" * 8, domain="testserver.local")
    response = await client.get("/api/v1/admin/health")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_admin_endpoints_reject_non_admins(auth_client: httpx.AsyncClient) -> None:
    for path in ("/api/v1/admin/jobs", "/api/v1/admin/users"):
        response = await auth_client.get(path)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"


async def test_admin_jobs_lists_newest_first(admin_client: httpx.AsyncClient, db: Session) -> None:
    book = make_book(db)
    uploader = make_user(db, username="uploader")
    for i in range(3):
        job = Job(
            type="ingest",
            book_id=book.id,
            user_id=uploader.id,
            status="done",
            created_at=datetime.now(UTC) - timedelta(minutes=i),
        )
        db.add(job)
    db.commit()
    response = await admin_client.get("/api/v1/admin/jobs")
    assert response.status_code == 200
    jobs = response.json()["items"]
    assert [j["status"] for j in jobs] == ["done", "done", "done"]
    assert [j["book_title"] for j in jobs] == [book.title, book.title, book.title]
    assert [j["user_username"] for j in jobs] == ["uploader", "uploader", "uploader"]
    assert [j["user_name"] for j in jobs] == ["Uploader", "Uploader", "Uploader"]
    dates = [j["created_at"] for j in jobs]
    assert dates == sorted(dates, reverse=True)


async def test_admin_users_lists_local_users_read_only(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    make_user(db, username="someone", role="user")
    db.commit()
    response = await admin_client.get("/api/v1/admin/users")
    assert response.status_code == 200
    names = {u["username"] for u in response.json()["items"]}
    assert "someone" in names and "testadmin" in names


def test_can_edit_book_admin_uploader_other(db: Session) -> None:
    admin = make_user(db, username="boss", role="admin")
    uploader = make_user(db, username="uploader")
    other = make_user(db, username="other")
    book = make_book(db, uploaded_by=uploader.id)
    foreign = make_book(db, uploaded_by=other.id)
    assert can_edit_book(admin, book) is True  # admin edits anything
    assert can_edit_book(uploader, book) is True  # uploader edits their own
    assert can_edit_book(other, book) is False  # nobody else does
    assert can_edit_book(uploader, foreign) is False


async def test_auth_options_reports_test_mode(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/v1/auth/options")
    assert response.status_code == 200
    assert response.json() == {"test_mode": True}
