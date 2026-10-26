"""Task 8: the books API — upload, dedupe, list/search, detail, cover, delete, reprocess."""

from __future__ import annotations

import hashlib
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from factories import make_book, make_user
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio import worker
from folio.config import Settings
from folio.db import SessionLocal
from folio.ingest import DRM_MESSAGE
from folio.main import create_app
from folio.models import Book, BookFile, Chapter, Job, Progress, Segment, User
from folio.routers import books as books_module
from folio.storage import book_dir, cover_dir


async def upload(client: httpx.AsyncClient, path: Path, name: str | None = None) -> httpx.Response:
    with path.open("rb") as fh:
        return await client.post(
            "/api/v1/books",
            files={"files": (name or path.name, fh, "application/octet-stream")},
            headers={"X-CSRF-Token": client.cookies.get("folio_csrf", "")},
        )


def run_worker(settings: Settings) -> None:
    """Process exactly one queued job through the real handler."""
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()


def _reload(db: Session, book_id: UUID) -> Book:
    db.expire_all()
    book = db.get(Book, book_id)
    assert book is not None
    return book


async def test_upload_epub3_creates_rows_and_reaches_ready(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    data = fixture_books["epub3"].read_bytes()
    response = await upload(auth_client, fixture_books["epub3"])
    assert response.status_code == 200, response.text
    (result,) = response.json()
    book_id = UUID(result["book_id"])
    assert result["duplicate_of"] is None
    assert db.scalar(select(func.count()).select_from(Book)) == 1
    book = _reload(db, book_id)
    assert book.status == "uploading"
    assert book.title == "epub3"  # filename stem until the pipeline reads the file
    file = db.scalar(select(BookFile).where(BookFile.book_id == book_id))
    assert file is not None
    assert file.kind == "original" and file.format == "epub"
    assert file.sha256 == hashlib.sha256(data).hexdigest()
    assert file.size_bytes == len(data)
    assert Path(file.path).is_file()
    assert db.scalar(select(func.count()).select_from(Job)) == 1
    run_worker(settings)
    assert _reload(db, book_id).status == "ready"


async def test_upload_requires_csrf_and_session(
    client: httpx.AsyncClient, fixture_books: dict[str, Path]
) -> None:
    assert (await client.get("/api/v1/books")).status_code == 401  # no session yet
    await client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    response = await client.post(
        "/api/v1/books",
        files={
            "files": ("epub3.epub", fixture_books["epub3"].read_bytes(), "application/octet-stream")
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_duplicate_bytes_link_to_the_existing_book(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    first = (await upload(auth_client, fixture_books["epub3"])).json()[0]
    second = (await upload(auth_client, fixture_books["epub3"])).json()[0]
    assert second["book_id"] == first["book_id"]
    assert second["duplicate_of"] == first["book_id"]
    assert second["job_id"] is None
    assert db.scalar(select(func.count()).select_from(Book)) == 1
    assert db.scalar(select(func.count()).select_from(Job)) == 1


async def test_drm_epub_is_rejected_at_upload(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    response = await upload(auth_client, fixture_books["drm_epub"])
    assert response.status_code == 422
    assert response.json()["error"] == {"code": "unsupported_format", "message": DRM_MESSAGE}
    assert db.scalar(select(func.count()).select_from(Book)) == 0
    assert db.scalar(select(func.count()).select_from(Job)) == 0


async def test_kfx_magic_is_rejected_at_upload(
    auth_client: httpx.AsyncClient, db: Session, tmp_path: Path
) -> None:
    kfx = tmp_path / "book.kfx"
    kfx.write_bytes(b"\x00" * 60 + b"\xeaDRMION\xee" + b"\x00" * 100)
    response = await upload(auth_client, kfx)
    assert response.status_code == 422
    assert response.json()["error"]["message"] == DRM_MESSAGE
    assert db.scalar(select(func.count()).select_from(Book)) == 0


async def test_pdf_renamed_epub_is_ingested_as_pdf(
    auth_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    fixture_books: dict[str, Path],
    tmp_path: Path,
) -> None:
    renamed = tmp_path / "sneaky.epub"
    shutil.copy(fixture_books["pdf_outline"], renamed)
    (result,) = (await upload(auth_client, renamed)).json()
    book_id = UUID(result["book_id"])
    assert db.scalar(select(BookFile.format).where(BookFile.book_id == book_id)) == "pdf"
    run_worker(settings)
    assert _reload(db, book_id).status == "ready"


async def test_oversized_upload_is_413(
    auth_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    fixture_books: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        books_module, "get_settings", lambda: settings.model_copy(update={"max_upload_mb": 0})
    )
    response = await upload(auth_client, fixture_books["epub3"])
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "upload_too_large"
    assert db.scalar(select(func.count()).select_from(Book)) == 0
    assert not list((settings.data_dir / "tmp").glob("*"))  # temp file cleaned up


async def test_unsupported_text_file_is_422(
    auth_client: httpx.AsyncClient, db: Session, tmp_path: Path
) -> None:
    txt = tmp_path / "notes.txt"
    txt.write_bytes(b"just some text, definitely not an ebook")
    response = await upload(auth_client, txt)
    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "unsupported_format",
        "message": "Unsupported file type",
    }
    assert db.scalar(select(func.count()).select_from(Book)) == 0


def _seed_books(db: Session) -> None:
    db.add_all(
        [
            Book(title="The Lighthouse Keeper's Almanac", authors=["Zed, Ann"], status="ready"),
            Book(title="Bread and Butter", authors=["Ann Beta"], status="failed", error="boom"),
        ]
    )
    db.commit()


async def test_list_search_sort_and_filter(auth_client: httpx.AsyncClient, db: Session) -> None:
    _seed_books(db)
    body = (await auth_client.get("/api/v1/books")).json()
    assert body["page_size"] == 24 and body["page"] == 1 and body["total"] == 2
    found = (await auth_client.get("/api/v1/books", params={"q": "lighthouse"})).json()
    assert [b["title"] for b in found["items"]] == ["The Lighthouse Keeper's Almanac"]
    by_title = (await auth_client.get("/api/v1/books", params={"sort": "title"})).json()
    assert [b["title"] for b in by_title["items"]] == [
        "Bread and Butter",
        "The Lighthouse Keeper's Almanac",
    ]
    by_author = (await auth_client.get("/api/v1/books", params={"sort": "author"})).json()
    assert [b["title"] for b in by_author["items"]] == [
        "Bread and Butter",
        "The Lighthouse Keeper's Almanac",
    ]
    assert (await auth_client.get("/api/v1/books", params={"sort": "progress"})).status_code == 200
    failed = (await auth_client.get("/api/v1/books", params={"status": "failed"})).json()
    assert [b["title"] for b in failed["items"]] == ["Bread and Butter"]


async def test_search_escapes_injection_attempts(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    _seed_books(db)
    for q in ["' OR 1=1 --", "& | ! ( ) <>", 'lighthouse" & "keeper', "\\\\"]:
        response = await auth_client.get("/api/v1/books", params={"q": q})
        assert response.status_code == 200, (q, response.text)


async def test_detail_shape(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(auth_client, fixture_books["epub3"])).json()
    book_id = UUID(result["book_id"])
    run_worker(settings)
    body = (await auth_client.get(f"/api/v1/books/{book_id}")).json()
    assert body["progress"] is None
    assert body["book"]["cover_url"] is None
    assert "uploaded_by" not in body["book"] and body["book"]["locked_fields"] == []
    listed = (await auth_client.get("/api/v1/books")).json()["items"][0]
    assert listed["locked_fields"] == []  # exposed in every book payload
    assert [c["idx"] for c in body["chapters"]] == list(range(len(body["chapters"])))
    assert (await auth_client.get(f"/api/v1/books/{UUID(int=0)}")).status_code == 404


async def test_cover_headers_and_404(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(auth_client, fixture_books["pdf_outline"])).json()
    book_id = UUID(result["book_id"])
    run_worker(settings)
    book = _reload(db, book_id)
    assert book.cover_key
    response = await auth_client.get(f"/api/v1/books/{book_id}/cover")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["etag"].strip('"') == f"{book.cover_key}-600"
    assert response.headers["content-type"].startswith("image/")
    assert (
        await auth_client.get(f"/api/v1/books/{book_id}/cover", params={"size": 200})
    ).status_code == 200
    assert (
        await auth_client.get(f"/api/v1/books/{book_id}/cover", params={"size": 300})
    ).status_code == 422
    plain = Book(title="No Cover", status="ready")
    db.add(plain)
    db.commit()
    assert (await auth_client.get(f"/api/v1/books/{plain.id}/cover")).status_code == 404


async def test_delete_permissions_and_cleanup(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(auth_client, fixture_books["epub3"])).json()
    book_id = UUID(result["book_id"])
    await auth_client.post("/api/v1/test/login", json={"username": "someoneelse", "role": "user"})
    denied = await auth_client.delete(
        f"/api/v1/books/{book_id}",
        headers={"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")},
    )
    assert denied.status_code == 403
    await auth_client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    headers = {"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")}
    assert (
        await auth_client.delete(f"/api/v1/books/{book_id}", headers=headers)
    ).status_code == 204
    db.expire_all()
    assert db.get(Book, book_id) is None
    assert db.scalar(select(func.count()).select_from(BookFile)) == 0
    assert not book_dir(settings, book_id).exists() and not cover_dir(settings, book_id).exists()


async def test_admin_deletes_any_book(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(admin_client, fixture_books["epub3"])).json()
    book_id = UUID(result["book_id"])
    await admin_client.post("/api/v1/test/login", json={"username": "otheradmin", "role": "admin"})
    response = await admin_client.delete(
        f"/api/v1/books/{book_id}",
        headers={"X-CSRF-Token": admin_client.cookies.get("folio_csrf", "")},
    )
    assert response.status_code == 204


async def test_reprocess_clears_and_reenqueues(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(auth_client, fixture_books["epub3"])).json()
    book_id = UUID(result["book_id"])
    run_worker(settings)
    assert len(list(db.scalars(select(Chapter).where(Chapter.book_id == book_id)))) > 0
    jobs_before = db.scalar(select(func.count()).select_from(Job))
    response = await auth_client.post(
        f"/api/v1/books/{book_id}/reprocess",
        headers={"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")},
    )
    assert response.status_code == 200
    assert UUID(response.json()["job_id"])
    book = _reload(db, book_id)
    assert book.status == "uploading"
    assert list(db.scalars(select(Chapter).where(Chapter.book_id == book_id))) == []
    assert list(db.scalars(select(Segment))) == []
    assert db.scalar(select(func.count()).select_from(Job)) == jobs_before + 1
    # another user may not reprocess
    await auth_client.post("/api/v1/test/login", json={"username": "someoneelse", "role": "user"})
    denied = await auth_client.post(
        f"/api/v1/books/{book_id}/reprocess",
        headers={"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")},
    )
    assert denied.status_code == 403


async def test_segments_endpoint(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings, fixture_books: dict[str, Path]
) -> None:
    (result,) = (await upload(auth_client, fixture_books["epub3"])).json()
    book_id = UUID(result["book_id"])
    run_worker(settings)
    detail = (await auth_client.get(f"/api/v1/books/{book_id}")).json()
    chapter_id = detail["chapters"][0]["id"]
    body = (await auth_client.get(f"/api/v1/books/{book_id}/chapters/{chapter_id}/segments")).json()
    assert body["items"]
    assert body["items"][0]["idx"] == 0
    assert set(body["items"][0]) == {"id", "idx", "text", "char_start", "char_end"}
    assert all(item["text"] for item in body["items"])
    assert (
        await auth_client.get(f"/api/v1/books/{UUID(int=0)}/chapters/{chapter_id}/segments")
    ).status_code == 404


async def test_upload_multiple_files_in_one_request(
    auth_client: httpx.AsyncClient, db: Session, fixture_books: dict[str, Path]
) -> None:
    with fixture_books["epub3"].open("rb") as a, fixture_books["pdf_outline"].open("rb") as b:
        response = await auth_client.post(
            "/api/v1/books",
            files=[
                ("files", ("epub3.epub", a, "application/octet-stream")),
                ("files", ("pdf_outline.pdf", b, "application/octet-stream")),
            ],
            headers={"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")},
        )
    assert response.status_code == 200
    results: list[dict[str, Any]] = response.json()
    assert len(results) == 2 and {r["book_id"] for r in results}
    assert db.scalar(select(func.count()).select_from(Book)) == 2


def _progress_book(db: Session, user_id: Any, updated_at: Any) -> Book:
    """Ready book with one chapter/segment and a progress row for ``user_id``."""
    book = Book(title=f"Progress {uuid4().hex[:8]}", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="Ch 0", char_count=100)
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text="s", char_start=0, char_end=100)
    db.add(segment)
    db.flush()
    db.add(
        Progress(
            user_id=user_id,
            book_id=book.id,
            chapter_id=chapter.id,
            segment_id=segment.id,
            offset_s=5.0,
            percent=10.0,
            updated_at=updated_at,
        )
    )
    db.commit()
    return book


async def test_sort_progress_orders_by_caller_not_others(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    now = datetime.now(UTC)
    stale = _progress_book(db, user.id, now - timedelta(hours=3))
    fresh = _progress_book(db, user.id, now - timedelta(hours=1))
    other_recent = _progress_book(db, make_user(db, username="other").id, now)
    plain = make_book(db, title="Never opened", status="ready")
    db.commit()

    body = (await auth_client.get("/api/v1/books", params={"sort": "progress"})).json()
    ids = [i["id"] for i in body["items"]]
    assert ids[:2] == [str(fresh.id), str(stale.id)]  # caller's recents first
    assert set(ids[2:]) == {str(other_recent.id), str(plain.id)}  # nulls last
    assert body["total"] == 4
    filtered = (
        await auth_client.get("/api/v1/books", params={"sort": "progress", "q": "never"})
    ).json()
    assert [i["id"] for i in filtered["items"]] == [str(plain.id)] and filtered["total"] == 1


async def test_can_edit_for_admin_uploader_and_other(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    mine = make_book(db, title="Mine", status="ready", uploaded_by=user.id)
    theirs = make_book(db, title="Theirs", status="ready", uploaded_by=make_user(db).id)
    db.commit()

    async def flags(client: httpx.AsyncClient) -> dict[str, bool]:
        items = (await client.get("/api/v1/books")).json()["items"]
        return {i["title"]: i["can_edit"] for i in items}

    assert await flags(auth_client) == {"Mine": True, "Theirs": False}
    detail = (await auth_client.get(f"/api/v1/books/{theirs.id}")).json()["book"]
    assert detail["can_edit"] is False and "uploaded_by" not in detail
    mine_detail = (await auth_client.get(f"/api/v1/books/{mine.id}")).json()["book"]
    assert mine_detail["can_edit"] is True and "uploaded_by" not in mine_detail

    # A second client: auth_client/admin_client share one cookie jar in conftest.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="https://testserver"
    ) as admin:
        await admin.post("/api/v1/test/login", json={"username": "testadmin", "role": "admin"})
        assert await flags(admin) == {"Mine": True, "Theirs": True}
        admin_detail = (await admin.get(f"/api/v1/books/{theirs.id}")).json()["book"]
        assert admin_detail["can_edit"] is True
