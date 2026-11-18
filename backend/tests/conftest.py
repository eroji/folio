"""Test harness fixtures: settings, db, client, auth_client, admin_client, fixture_books.

Environment defaults are set before importing folio because folio.db builds
the engine from DATABASE_URL at import time. TEST_DATABASE_URL overrides the
target database; it defaults to the folio_test db and is created if missing.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

os.environ.setdefault(
    "TEST_DATABASE_URL", "postgresql+psycopg://folio:folio@localhost:5432/folio_test"
)
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
os.environ.setdefault("FOLIO_BASE_URL", "http://testserver")
os.environ["FOLIO_SECRET_KEY"] = "test"
os.environ["FOLIO_TEST_MODE"] = "true"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="folio-data-")
os.environ.setdefault("LDAP_URL", "ldaps://ldap.test:636")
os.environ.setdefault("LDAP_BIND_DN", "cn=svc,dc=test")
os.environ.setdefault("LDAP_BIND_PASSWORD", "svc-password")
os.environ.setdefault("LDAP_BASE_DN", "dc=test")
os.environ.setdefault("FOLIO_LDAP_ADMIN_GROUP", "cn=folio-admin,dc=test")
os.environ.setdefault("FOLIO_LDAP_USER_GROUP", "cn=folio-user,dc=test")
# No test hits the metadata providers unless it opts in (monkeypatch metadata_online).
os.environ.setdefault("METADATA_ONLINE", "false")
# No test reaches a real TTS engine either: an unreachable url leaves voice
# discovery with no list, so a requested voice is trusted and no clip is keyed
# by a real engine's audio.
os.environ.setdefault("TTS_BASE_URL", "http://tts-harness.test/v1")

import httpx
import psycopg
import pytest
from psycopg import sql
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.db import Base, SessionLocal, engine
from folio.main import create_app

FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURE_FILES = {
    "epub3": "epub3.epub",
    "epub2": "epub2.epub",
    "pdf_outline": "pdf_outline.pdf",
    "pdf_flat": "pdf_flat.pdf",
    "scanned_pdf": "scanned_pdf.pdf",
    "drm_epub": "drm_epub.epub",
    "azw3": "azw3.azw3",
}


@pytest.fixture(scope="session")
def settings() -> Settings:
    return get_settings()


def _ensure_database(database_url: str) -> None:
    """Create the test database if missing, via the server's postgres db."""
    url = make_url(database_url)
    assert url.database and url.host
    maint = f"postgresql://{url.username}:{url.password}@{url.host}:{url.port or 5432}/postgres"
    with psycopg.connect(maint, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (url.database,)
        ).fetchone()
        if not exists:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(url.database)))


@pytest.fixture(scope="session")
def _schema(settings: Settings) -> None:
    _ensure_database(settings.database_url)
    Base.metadata.create_all(engine)


@pytest.fixture()
def db(_schema: None) -> Iterator[Session]:
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)

    def truncate() -> None:
        # Any connection still holding a transaction blocks TRUNCATE's ACCESS
        # EXCLUSIVE lock (seen as an intermittent hang). Close the pool first,
        # and fail loudly instead of hanging forever if something still leaks.
        engine.dispose()
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))

    truncate()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        truncate()


@pytest.fixture()
async def client(db: Session) -> AsyncIterator[httpx.AsyncClient]:
    # https base_url so the Secure session cookies are stored and sent.
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        yield client


async def _login(client: httpx.AsyncClient, username: str, role: str) -> None:
    response = await client.post("/api/v1/test/login", json={"username": username, "role": role})
    assert response.status_code == 200, response.text


@pytest.fixture()
async def auth_client(client: httpx.AsyncClient) -> AsyncIterator[httpx.AsyncClient]:
    await _login(client, "testuser", "user")
    yield client


@pytest.fixture()
async def admin_client(client: httpx.AsyncClient) -> AsyncIterator[httpx.AsyncClient]:
    await _login(client, "testadmin", "admin")
    yield client


@pytest.fixture(scope="session")
def fixture_books() -> dict[str, Path]:
    books = {key: FIXTURES_DIR / name for key, name in FIXTURE_FILES.items()}
    missing = sorted(str(p.name) for p in books.values() if not p.exists())
    if missing:
        raise RuntimeError(f"missing fixture books {missing}: run `make fixtures`")
    return books


@pytest.fixture()
def mock_tts() -> Iterator[str]:
    from mock_tts import serve

    with serve() as url:
        yield url


@pytest.fixture(autouse=True)
def _google_books_not_paused(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 pauses Google Books process-wide; every test starts unpaused."""
    from folio.metadata import googlebooks

    monkeypatch.setattr(googlebooks, "_paused_until", 0.0)
