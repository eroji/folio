"""CSRF derivation and the double-submit check."""

import hmac

import httpx
from factories import make_session_row, make_user
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import get_settings
from folio.models import Session as SessionRow
from folio.security import csrf_for


def test_csrf_for_matches_the_harness_derivation() -> None:
    # The test-mode login endpoint pins: hmac(secret, session_id, sha256).hexdigest().
    token = "ab" * 32
    expected = hmac.new(b"test", token.encode(), "sha256").hexdigest()
    assert csrf_for(token, "test") == expected
    assert csrf_for(token, "other") != expected


async def test_missing_csrf_header_is_rejected(auth_client: httpx.AsyncClient) -> None:
    response = await auth_client.post("/api/v1/auth/logout")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_wrong_csrf_header_is_rejected(auth_client: httpx.AsyncClient) -> None:
    response = await auth_client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "0" * 64})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_session_row_csrf_equals_hmac_of_session_token(
    client: httpx.AsyncClient, db: Session
) -> None:
    """A hand-made session works when its csrf follows the pinned derivation."""
    user = make_user(db, username="csrfuser")
    row = make_session_row(db, user)
    derived = csrf_for(row.id, get_settings().folio_secret_key)
    row.csrf_token = derived
    db.commit()

    client.cookies.set("folio_session", row.id, domain="testserver.local")
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response.json()["csrf_token"] == derived

    ok = await client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": derived})
    assert ok.status_code == 200
    assert db.scalar(select(SessionRow).where(SessionRow.id == row.id)) is None


async def test_me_restores_a_lost_csrf_cookie(client: httpx.AsyncClient, db: Session) -> None:
    user = make_user(db, username="relaunch")
    row = make_session_row(db, user)
    db.commit()
    client.cookies.set("folio_session", row.id, domain="testserver.local")  # no folio_csrf
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == 200
    csrf_cookie = next(
        h for h in response.headers.get_list("set-cookie") if h.startswith("folio_csrf=")
    )
    assert csrf_cookie.startswith(f"folio_csrf={row.csrf_token};")
    assert "Max-Age=2592000" in csrf_cookie and "HttpOnly" not in csrf_cookie
