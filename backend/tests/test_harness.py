"""Prove the harness itself: client, db isolation, fixture books, mock TTS, test login."""

from __future__ import annotations

import zipfile
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.main import create_app
from folio.models import Session as SessionRow
from folio.models import User

EXPECTED_KEYS = {
    "epub3",
    "epub2",
    "pdf_outline",
    "pdf_flat",
    "scanned_pdf",
    "drm_epub",
    "azw3",
}


async def test_client_reaches_healthz(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_settings_overrides(settings: Settings) -> None:
    assert settings.folio_test_mode is True
    assert settings.folio_secret_key == "test"
    assert "folio-data-" in str(settings.data_dir)


def test_db_starts_empty(db: Session) -> None:
    assert db.scalar(select(func.count()).select_from(User)) == 0
    db.add(
        User(
            ldap_dn="uid=inserted,dc=test",
            username="inserted",
            display_name="Inserted",
            email=None,
            role="user",
        )
    )
    db.commit()
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_db_is_truncated_between_tests(db: Session) -> None:
    # Runs after the previous test; the truncate in the db fixture must have cleared it.
    assert db.scalar(select(func.count()).select_from(User)) == 0


async def test_test_login_seeds_user_and_session(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None and user.role == "user"
    assert db.scalar(select(func.count()).select_from(SessionRow)) == 1
    assert "folio_session" in auth_client.cookies and "folio_csrf" in auth_client.cookies
    response = await auth_client.get("/api/v1/admin/health")
    assert response.status_code == 200
    assert response.json()["db"] == "ok"


async def test_test_login_role_admin(admin_client: httpx.AsyncClient, db: Session) -> None:
    user = db.scalar(select(User).where(User.username == "testadmin"))
    assert user is not None and user.role == "admin"


async def test_test_login_absent_when_mode_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FOLIO_TEST_MODE", "false")
    get_settings.cache_clear()
    try:
        transport = httpx.ASGITransport(app=create_app())
        async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
            response = await client.post(
                "/api/v1/test/login", json={"username": "x", "role": "user"}
            )
        assert response.status_code == 404
    finally:
        get_settings.cache_clear()


def test_fixture_books_complete(fixture_books: dict[str, Path]) -> None:
    assert set(fixture_books) == EXPECTED_KEYS
    import pymupdf

    for name, path in fixture_books.items():
        assert path.exists() and path.stat().st_size > 100, name
    for name in ("epub3", "epub2", "drm_epub"):
        with zipfile.ZipFile(fixture_books[name]) as archive:
            assert "mimetype" in archive.namelist(), name
            assert archive.read("mimetype").startswith(b"application/epub+zip"), name
    with zipfile.ZipFile(fixture_books["epub3"]) as archive:
        assert any(n.endswith("nav.xhtml") for n in archive.namelist())
    with zipfile.ZipFile(fixture_books["epub2"]) as archive:
        assert any(n.endswith("toc.ncx") for n in archive.namelist())
        opf = next(n for n in archive.namelist() if n.endswith(".opf"))
        assert b'version="2.0"' in archive.read(opf)
    with zipfile.ZipFile(fixture_books["drm_epub"]) as archive:
        assert "META-INF/encryption.xml" in archive.namelist()
    assert fixture_books["azw3"].read_bytes()[60:68] == b"BOOKMOBI"
    for name in ("pdf_outline", "pdf_flat"):
        with pymupdf.open(fixture_books[name]) as doc:
            assert len(doc) >= 24, name
    with pymupdf.open(fixture_books["pdf_outline"]) as doc:
        assert doc.get_toc(), "pdf_outline must have an outline"
    with pymupdf.open(fixture_books["pdf_flat"]) as doc:
        assert not doc.get_toc()
        assert len(doc[0].get_text().strip()) > 200
    with pymupdf.open(fixture_books["scanned_pdf"]) as doc:
        assert sum(len(page.get_text().strip()) for page in doc) < 200 * len(doc)


def test_mock_tts(mock_tts: str) -> None:
    response = httpx.get(f"{mock_tts}/v1/audio/voices")
    assert response.status_code == 200
    assert response.json() == {"voices": [{"id": "ashley-en", "language": "en"}]}
    response = httpx.post(
        f"{mock_tts}/v1/audio/speech", json={"input": "hello", "voice": "ashley-en"}
    )
    assert response.status_code == 200
    assert response.content.startswith(b"OggS")
