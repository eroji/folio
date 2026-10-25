"""M3 Task A: cover validation, resizing, serving, and the cover endpoints."""

from __future__ import annotations

import hashlib
import io
from typing import Any
from uuid import uuid4

import httpx
import pytest
from factories import make_user
from PIL import Image
from sqlalchemy.orm import Session

from folio import covers
from folio.config import Settings
from folio.covers import (
    DOWNLOAD_TIMEOUT_S,
    MAX_COVER_BYTES,
    MAX_REDIRECTS,
    cover_path,
    delete_covers,
)
from folio.errors import ApiError
from folio.models import Book
from folio.routers import covers as covers_module
from folio.storage import cover_dir


def _image_bytes(fmt: str, size: tuple[int, int] = (400, 400), color: str = "tomato") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, fmt)
    return buf.getvalue()


def _book(db: Session, **fields: Any) -> Book:
    book = Book(title="Covered", status="ready", **fields)
    db.add(book)
    db.commit()
    return book


def _csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _client(handler: Any) -> httpx.Client:
    return httpx.Client(
        transport=httpx.MockTransport(handler),
        timeout=DOWNLOAD_TIMEOUT_S,
        follow_redirects=True,
        max_redirects=MAX_REDIRECTS,
    )


def _ok(body: bytes) -> httpx.Response:
    """A streaming 200 so ``iter_raw`` works exactly like a real download."""
    return httpx.Response(200, stream=httpx.ByteStream(body))


def _override_client(client: httpx.AsyncClient, handler: Any) -> None:
    """Route the cover-url endpoint's downloads through a MockTransport."""
    app: Any = client._transport.app  # type: ignore[attr-defined]
    app.dependency_overrides[covers_module.get_http_client] = lambda: _client(handler)


# --- detect_image_type -------------------------------------------------------


def test_detect_image_type_reads_magic_bytes_only() -> None:
    assert covers.detect_image_type(_image_bytes("PNG")) == "png"
    assert covers.detect_image_type(_image_bytes("JPEG")) == "jpeg"
    assert covers.detect_image_type(_image_bytes("WEBP")) == "webp"
    assert covers.detect_image_type(b"GIF89a" + b"\x00" * 32) is None
    assert covers.detect_image_type(b"<html><body>hi</body></html>") is None
    assert covers.detect_image_type(b"") is None
    assert covers.detect_image_type(b"RIFF\x08\x00\x00\x00XXXX") is None


# --- store_cover -------------------------------------------------------------


def test_store_cover_writes_original_and_both_variants(settings: Settings) -> None:
    book_id = uuid4()
    data = _image_bytes("JPEG", (1000, 500))
    key = covers.store_cover(settings, book_id, data)
    assert key == hashlib.sha256(data).hexdigest()
    directory = cover_dir(settings, book_id)
    assert (directory / "original.jpeg").read_bytes() == data
    for width in (600, 200):
        with Image.open(directory / f"cover-{width}.webp") as image:
            assert image.format == "WEBP"
            assert image.mode == "RGB"
            assert image.size == (width, width * 3 // 2)


def test_store_cover_replaces_the_previous_cover(settings: Settings) -> None:
    book_id = uuid4()
    covers.store_cover(settings, book_id, _image_bytes("PNG"))
    key = covers.store_cover(settings, book_id, _image_bytes("WEBP"))
    names = sorted(p.name for p in cover_dir(settings, book_id).iterdir())
    assert names == ["cover-200.webp", "cover-600.webp", "original.webp"]
    assert key == hashlib.sha256(_image_bytes("WEBP")).hexdigest()


def test_store_cover_rejects_bad_type_and_oversize(settings: Settings) -> None:
    book_id = uuid4()
    good = _image_bytes("PNG")
    covers.store_cover(settings, book_id, good)
    before = {p.name: p.read_bytes() for p in cover_dir(settings, book_id).iterdir()}

    with pytest.raises(ApiError) as excinfo:
        covers.store_cover(settings, book_id, b"not an image at all")
    assert excinfo.value.code == "cover_invalid"
    assert excinfo.value.status == 422
    assert excinfo.value.message

    with pytest.raises(ApiError) as excinfo:
        covers.store_cover(settings, book_id, good + b"\x00" * MAX_COVER_BYTES)
    assert excinfo.value.code == "cover_invalid"
    assert "10 MB" in excinfo.value.message

    # every rejection left the existing cover untouched
    assert {p.name: p.read_bytes() for p in cover_dir(settings, book_id).iterdir()} == before


def test_store_cover_rejects_bytes_that_pass_magic_but_do_not_decode(settings: Settings) -> None:
    book_id = uuid4()
    with pytest.raises(ApiError) as excinfo:
        covers.store_cover(settings, book_id, b"\xff\xd8\xff" + b"broken jpeg")
    assert excinfo.value.code == "cover_invalid"
    assert not cover_dir(settings, book_id).exists()


def test_store_cover_crops_a_tall_image_to_2_3(settings: Settings) -> None:
    book_id = uuid4()
    covers.store_cover(settings, book_id, _image_bytes("PNG", (600, 2400), "seagreen"))
    with Image.open(cover_dir(settings, book_id) / "cover-600.webp") as image:
        assert image.size == (600, 900)


# --- cover_path / delete_covers ----------------------------------------------


def test_cover_path_resolves_sizes_and_original(settings: Settings) -> None:
    book_id = uuid4()
    assert cover_path(settings, book_id, 600) is None
    assert cover_path(settings, book_id, None) is None
    covers.store_cover(settings, book_id, _image_bytes("WEBP"))
    assert cover_path(settings, book_id, 600) == cover_dir(settings, book_id) / "cover-600.webp"
    assert cover_path(settings, book_id, 200) == cover_dir(settings, book_id) / "cover-200.webp"
    assert cover_path(settings, book_id, None) == cover_dir(settings, book_id) / "original.webp"


def test_delete_covers_removes_the_directory(settings: Settings) -> None:
    book_id = uuid4()
    covers.store_cover(settings, book_id, _image_bytes("PNG"))
    delete_covers(settings, book_id)
    assert not cover_dir(settings, book_id).exists()
    delete_covers(settings, book_id)  # idempotent


# --- download_cover ----------------------------------------------------------


def test_download_cover_constants() -> None:
    assert MAX_COVER_BYTES == 10 * 1024 * 1024
    assert DOWNLOAD_TIMEOUT_S == 10.0


def test_download_cover_returns_the_bytes() -> None:
    data = _image_bytes("PNG")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "covers.example"
        return _ok(data)

    assert covers.download_cover("https://covers.example/a.png", _client(handler)) == data


def test_download_cover_follows_redirects() -> None:
    data = _image_bytes("JPEG")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/short":
            return httpx.Response(302, headers={"location": "/real.jpg"})
        return _ok(data)

    assert covers.download_cover("https://covers.example/short", _client(handler)) == data
    assert seen == ["/short", "/real.jpg"]


def test_download_cover_rejects_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"nope")

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover("https://covers.example/missing.jpg", _client(handler))
    assert excinfo.value.code == "cover_invalid"
    assert "404" in excinfo.value.message


def test_download_cover_rejects_timeout() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover("https://covers.example/slow.jpg", _client(handler))
    assert excinfo.value.code == "cover_invalid"
    assert "10" in excinfo.value.message


def test_download_cover_rejects_oversize() -> None:
    chunk = b"\x00" * (1024 * 1024)

    def handler(request: httpx.Request) -> httpx.Response:
        return _ok(chunk * (MAX_COVER_BYTES // len(chunk) + 1))

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover("https://covers.example/huge.png", _client(handler))
    assert excinfo.value.code == "cover_invalid"
    assert "10 MB" in excinfo.value.message


def test_download_cover_rejects_a_non_image() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _ok(b"<html>cover</html>")

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover("https://covers.example/page.html", _client(handler))
    assert excinfo.value.code == "cover_invalid"


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://covers.example/a.png"])
def test_download_cover_rejects_non_http_schemes(url: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("no request may be made")

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover(url, _client(handler))
    assert excinfo.value.code == "cover_invalid"


def test_download_cover_caps_redirects() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/again"})

    with pytest.raises(ApiError) as excinfo:
        covers.download_cover("https://covers.example/loop", _client(handler))
    assert excinfo.value.code == "cover_invalid"


# --- POST /{book_id}/cover ---------------------------------------------------


async def test_upload_cover_stores_and_returns_the_payload(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db)
    data = _image_bytes("PNG", (800, 400))
    response = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("cover.png", data, "image/png")},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    key = hashlib.sha256(data).hexdigest()
    assert response.json() == {
        "cover_url": f"/api/v1/books/{book.id}/cover?v={key[:8]}",
        "cover_key": key,
    }
    db.expire_all()
    assert db.get(Book, book.id).cover_key == key
    served = await admin_client.get(f"/api/v1/books/{book.id}/cover", params={"size": 200})
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"


async def test_upload_cover_requires_csrf(auth_client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    response = await auth_client.post(
        f"/api/v1/books/{book.id}/cover", files={"file": ("c.png", _image_bytes("PNG"))}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_upload_cover_rejects_bad_type_and_oversize(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    headers = _csrf(admin_client)
    bad = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("c.bin", b"definitely not an image", "application/octet-stream")},
        headers=headers,
    )
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "cover_invalid"

    big = _image_bytes("PNG") + b"\x00" * MAX_COVER_BYTES
    over = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("big.png", big, "image/png")},
        headers=headers,
    )
    assert over.status_code == 413
    assert over.json()["error"]["code"] == "cover_too_large"
    db.expire_all()
    assert db.get(Book, book.id).cover_key is None


async def test_cover_endpoints_404_for_unknown_book(admin_client: httpx.AsyncClient) -> None:
    missing = uuid4()
    headers = _csrf(admin_client)
    upload = await admin_client.post(
        f"/api/v1/books/{missing}/cover",
        files={"file": ("c.png", _image_bytes("PNG"), "image/png")},
        headers=headers,
    )
    assert upload.status_code == 404
    by_url = await admin_client.put(
        f"/api/v1/books/{missing}/cover-url",
        json={"url": "https://covers.example/a.png"},
        headers=headers,
    )
    assert by_url.status_code == 404
    assert (await admin_client.get(f"/api/v1/books/{missing}/cover")).status_code == 404


async def test_cover_endpoints_forbid_other_users(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db, uploaded_by=make_user(db, username="someoneelse").id)
    headers = _csrf(auth_client)
    upload = await auth_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("c.png", _image_bytes("PNG"), "image/png")},
        headers=headers,
    )
    assert upload.status_code == 403
    assert upload.json()["error"]["code"] == "forbidden"
    by_url = await auth_client.put(
        f"/api/v1/books/{book.id}/cover-url",
        json={"url": "https://covers.example/a.png"},
        headers=headers,
    )
    assert by_url.status_code == 403


async def test_cover_get_requires_a_session(client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    assert (await client.get(f"/api/v1/books/{book.id}/cover")).status_code == 401


# --- PUT /{book_id}/cover-url ------------------------------------------------


async def test_cover_url_stores_the_downloaded_image(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db)
    data = _image_bytes("JPEG", (900, 1200))
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return _ok(data)

    _override_client(admin_client, handler)
    response = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url",
        json={"url": "https://covers.example/one.jpg"},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 200, response.text
    key = hashlib.sha256(data).hexdigest()
    assert response.json() == {
        "cover_url": f"/api/v1/books/{book.id}/cover?v={key[:8]}",
        "cover_key": key,
    }
    assert seen == ["https://covers.example/one.jpg"]
    assert cover_path(settings, book.id, None).read_bytes() == data
    assert cover_path(settings, book.id, 600) is not None


async def test_cover_url_failure_leaves_the_existing_cover(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db)
    good = _image_bytes("PNG")
    uploaded = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("c.png", good, "image/png")},
        headers=_csrf(admin_client),
    )
    assert uploaded.status_code == 200
    key = uploaded.json()["cover_key"]
    before = {p.name: p.read_bytes() for p in cover_dir(settings, book.id).iterdir()}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"gone")

    _override_client(admin_client, handler)
    response = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url",
        json={"url": "https://covers.example/gone.png"},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "cover_invalid"
    db.expire_all()
    assert db.get(Book, book.id).cover_key == key
    assert {p.name: p.read_bytes() for p in cover_dir(settings, book.id).iterdir()} == before


@pytest.mark.parametrize("status", [404, 500])
async def test_cover_url_maps_http_errors(
    admin_client: httpx.AsyncClient, db: Session, status: int
) -> None:
    book = _book(db)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=b"no")

    _override_client(admin_client, handler)
    response = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url",
        json={"url": "https://covers.example/x.png"},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 422
    assert str(status) in response.json()["error"]["message"]


async def test_cover_url_rejects_timeout_and_empty_url(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    _override_client(admin_client, handler)
    response = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url",
        json={"url": "https://covers.example/x.png"},
        headers=_csrf(admin_client),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "cover_invalid"
    empty = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url", json={"url": ""}, headers=_csrf(admin_client)
    )
    assert empty.status_code == 422


async def test_cover_url_requires_csrf(admin_client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    response = await admin_client.put(
        f"/api/v1/books/{book.id}/cover-url", json={"url": "https://covers.example/a.png"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


# --- GET /{book_id}/cover ----------------------------------------------------


async def test_cover_serves_variants_with_etag_and_304(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    stored = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("c.webp", _image_bytes("WEBP", (500, 500)), "image/webp")},
        headers=_csrf(admin_client),
    )
    key = stored.json()["cover_key"]

    for size in ("600", "200", "original"):
        response = await admin_client.get(f"/api/v1/books/{book.id}/cover", params={"size": size})
        assert response.status_code == 200, (size, response.text)
        assert response.headers["content-type"] == "image/webp"
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert response.headers["etag"] == f'"{key}-{size}"'
        fresh = await admin_client.get(
            f"/api/v1/books/{book.id}/cover",
            params={"size": size},
            headers={"If-None-Match": response.headers["etag"]},
        )
        assert fresh.status_code == 304
        assert not fresh.content
        stale = await admin_client.get(
            f"/api/v1/books/{book.id}/cover",
            params={"size": size},
            headers={"If-None-Match": '"deadbeef-600"'},
        )
        assert stale.status_code == 200

    assert (
        await admin_client.get(f"/api/v1/books/{book.id}/cover", params={"size": "300"})
    ).status_code == 422


async def test_cover_404_when_the_book_has_no_cover(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db)
    response = await admin_client.get(f"/api/v1/books/{book.id}/cover")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_cover_404_when_the_files_are_gone(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _book(db)
    stored = await admin_client.post(
        f"/api/v1/books/{book.id}/cover",
        files={"file": ("c.png", _image_bytes("PNG"), "image/png")},
        headers=_csrf(admin_client),
    )
    assert stored.status_code == 200
    delete_covers(settings, book.id)
    assert (await admin_client.get(f"/api/v1/books/{book.id}/cover")).status_code == 404


# --- pipeline integration ----------------------------------------------------


def test_pipeline_store_cover_uses_the_covers_service(settings: Settings) -> None:
    from folio.ingest.pipeline import _store_cover

    book = Book(id=uuid4(), title="Piped", status="ready")
    data = _image_bytes("JPEG", (700, 700))
    _store_cover(settings, book, data)
    assert book.cover_key == hashlib.sha256(data).hexdigest()
    assert cover_path(settings, book.id, 600) is not None
    _store_cover(settings, book, b"GIF89a" + b"\x00" * 40)  # unsupported: skipped, not raised
    assert book.cover_key == hashlib.sha256(data).hexdigest()
