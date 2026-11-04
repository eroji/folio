"""Task B API: prepare/retry endpoints, Range streaming, cache clear and TTS health."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from mock_tts import SILENT_OPUS
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio import main as main_module
from folio.config import Settings
from folio.main import create_app
from folio.models import Audio, Book, Chapter, Segment, SegmentAudio
from folio.routers import admin as admin_module
from folio.tts.cache import cache_key, cache_path
from folio.tts.queue import PRIORITY_LOOKAHEAD, PRIORITY_NOW
from folio.tts.text import normalize_speech_text


def _book_with_segments(db: Session, count: int = 2) -> tuple[Book, list[Segment]]:
    book = Book(title="Streamed", language="en", status="ready")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="One", char_count=count * 10)
    db.add(chapter)
    db.flush()
    segments = [
        Segment(
            chapter_id=chapter.id,
            idx=i,
            text=f"Streamable sentence number {i} with uuid {uuid.uuid4().hex}.",
            char_start=i * 10,
            char_end=(i + 1) * 10,
        )
        for i in range(count)
    ]
    db.add_all(segments)
    db.commit()
    return book, segments


def _audio(db: Session, settings: Settings, text: str, voice: str = "ashley-en") -> Audio:
    key = cache_key(
        settings.tts_model,
        voice,
        settings.tts_format,
        normalize_speech_text(text),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    path = cache_path(settings, key, settings.tts_format)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(SILENT_OPUS)
    row = Audio(
        cache_key=key,
        path=str(path),
        format=settings.tts_format,
        voice=voice,
        model=settings.tts_model,
        duration_s=1.0,
        bytes=len(SILENT_OPUS),
    )
    db.add(row)
    db.commit()
    return row


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


async def test_prepare_requires_session_and_csrf(client: httpx.AsyncClient, db: Session) -> None:
    book, segments = _book_with_segments(db)
    url = f"/api/v1/books/{book.id}/audio/prepare"
    body = {"segment_id": str(segments[0].id), "count": 1}
    assert (await client.post(url, json=body)).status_code == 401  # no session
    await client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    response = await client.post(url, json=body)  # session but no CSRF header
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_prepare_queues_window_and_is_idempotent(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, segments = _book_with_segments(db, count=3)
    response = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(segments[0].id), "count": 2},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["language"] == "en" and payload["voice"] == "ashley-en"
    assert [item["segment_id"] for item in payload["items"]] == [str(s.id) for s in segments]
    assert all(item["status"] == "queued" and item["url"] is None for item in payload["items"])
    assert db.scalar(select(SegmentAudio).where(SegmentAudio.priority == 10)) is not None

    again = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(segments[0].id), "count": 2},
        headers=csrf(auth_client),
    )
    assert [i["segment_id"] for i in again.json()["items"]] == [str(s.id) for s in segments]
    assert len(db.scalars(select(SegmentAudio)).all()) == 3  # no duplicate rows


async def test_prepare_accepts_a_whole_chapter_beyond_the_old_cap(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    """A player prefetching its chapter asks for every remaining segment."""
    book, segments = _book_with_segments(db, count=150)
    response = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(segments[7].id), "count": len(segments)},
        headers=csrf(auth_client),
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["segment_id"] for item in items] == [str(s.id) for s in segments[7:]]
    rows = db.scalars(select(SegmentAudio)).all()
    assert len(rows) == len(segments) - 7  # the rest of the chapter is queued
    priority = {row.segment_id: row.priority for row in rows}
    assert priority[segments[7].id] == PRIORITY_NOW  # the current segment goes first
    assert [priority[s.id] for s in segments[8:]] == [PRIORITY_LOOKAHEAD] * (len(segments) - 8)

    too_big = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(segments[0].id), "count": 2001},
        headers=csrf(auth_client),
    )
    assert too_big.status_code == 422


async def test_prepare_returns_ready_url_and_duration(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book, segments = _book_with_segments(db, count=1)
    audio = _audio(db, settings, segments[0].text)
    response = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(segments[0].id)},
        headers=csrf(auth_client),
    )
    (item,) = response.json()["items"]
    assert item["status"] == "ready"
    assert item["cache_key"] == audio.cache_key
    assert item["url"] == f"/api/v1/audio/{audio.cache_key}"
    assert item["duration_s"] == pytest.approx(1.0, abs=0.1)


async def test_prepare_segment_outside_book_is_404(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, _ = _book_with_segments(db, count=1)
    _other, other_segments = _book_with_segments(db, count=1)
    response = await auth_client.post(
        f"/api/v1/books/{book.id}/audio/prepare",
        json={"segment_id": str(other_segments[0].id)},
        headers=csrf(auth_client),
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_stream_full_file_with_range_headers(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    _book, segments = _book_with_segments(db, count=1)
    audio = _audio(db, settings, segments[0].text)
    response = await auth_client.get(f"/api/v1/audio/{audio.cache_key}")
    assert response.status_code == 200
    assert response.content == SILENT_OPUS
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-type"] == "audio/ogg"
    assert response.headers["cache-control"] == "private, max-age=31536000, immutable"
    db.expire_all()
    assert db.get(Audio, audio.cache_key).last_played_at is not None  # type: ignore[union-attr]


async def test_stream_range_returns_206_with_content_range(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    _book, segments = _book_with_segments(db, count=1)
    audio = _audio(db, settings, segments[0].text)
    response = await auth_client.get(
        f"/api/v1/audio/{audio.cache_key}", headers={"Range": "bytes=0-9"}
    )
    assert response.status_code == 206
    assert response.content == SILENT_OPUS[:10]
    assert response.headers["content-range"] == f"bytes 0-9/{len(SILENT_OPUS)}"


async def test_stream_unsatisfiable_range_is_416(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    _book, segments = _book_with_segments(db, count=1)
    audio = _audio(db, settings, segments[0].text)
    response = await auth_client.get(
        f"/api/v1/audio/{audio.cache_key}",
        headers={"Range": f"bytes={len(SILENT_OPUS) + 100}-"},
    )
    assert response.status_code == 416


async def test_stream_unknown_key_is_404_and_requires_session(
    client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    _book, segments = _book_with_segments(db, count=1)
    audio = _audio(db, settings, segments[0].text)
    await client.post("/api/v1/test/login", json={"username": "testuser", "role": "user"})
    unknown = uuid.uuid4().hex  # valid sha256 shape, no such row
    assert (await client.get(f"/api/v1/audio/{unknown}")).status_code == 404
    assert (await client.get("/api/v1/audio/not-a-hex-key")).status_code == 404
    bare = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="https://testserver"
    )
    async with bare:
        assert (await bare.get(f"/api/v1/audio/{audio.cache_key}")).status_code == 401


async def test_retry_resets_failed_segment(auth_client: httpx.AsyncClient, db: Session) -> None:
    book, segments = _book_with_segments(db, count=1)
    db.add(
        SegmentAudio(
            segment_id=segments[0].id, voice="ashley-en", status="failed", error="TTS down"
        )
    )
    db.commit()
    url = f"/api/v1/books/{book.id}/audio/retry"
    assert (
        await auth_client.post(url, json={"segment_id": str(segments[0].id)})
    ).status_code == 403  # CSRF first
    response = await auth_client.post(
        url, json={"segment_id": str(segments[0].id)}, headers=csrf(auth_client)
    )
    assert response.status_code == 202
    assert response.json() == {"status": "queued"}
    assert db.scalar(select(SegmentAudio)).status == "queued"


async def test_admin_cache_clear_per_book_and_entire(
    admin_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book_a, segments_a = _book_with_segments(db, count=1)
    _book_b, segments_b = _book_with_segments(db, count=1)
    audio_a = _audio(db, settings, segments_a[0].text)
    audio_b = _audio(db, settings, segments_b[0].text)
    path_a, path_b = audio_a.path, audio_b.path  # the rows themselves go on clear
    key_a, key_b = audio_a.cache_key, audio_b.cache_key
    db.add_all(
        [
            SegmentAudio(
                segment_id=segments_a[0].id,
                voice="ashley-en",
                cache_key=audio_a.cache_key,
                status="ready",
            ),
            SegmentAudio(
                segment_id=segments_b[0].id,
                voice="ashley-en",
                cache_key=audio_b.cache_key,
                status="ready",
            ),
        ]
    )
    db.commit()

    response = await admin_client.post(
        "/api/v1/admin/cache/clear", json={"book_id": str(book_a.id)}, headers=csrf(admin_client)
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"removed_files": 1, "freed_bytes": len(SILENT_OPUS)}
    assert not Path(path_a).exists()
    assert Path(path_b).exists()
    db.expire_all()
    assert db.get(Audio, key_a) is None
    assert db.get(Audio, key_b) is not None
    row_a = db.scalar(select(SegmentAudio).where(SegmentAudio.segment_id == segments_a[0].id))
    assert row_a is not None and row_a.cache_key is None  # SET NULL cascade, row survives

    response = await admin_client.post(
        "/api/v1/admin/cache/clear", json={}, headers=csrf(admin_client)
    )
    assert response.json() == {"removed_files": 1, "freed_bytes": len(SILENT_OPUS)}
    assert not Path(path_b).exists()
    assert db.scalar(select(Audio)) is None


async def test_admin_cache_clear_requires_csrf(admin_client: httpx.AsyncClient) -> None:
    response = await admin_client.post("/api/v1/admin/cache/clear", json={})  # no CSRF header
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_cache_clear_rejects_non_admins(auth_client: httpx.AsyncClient) -> None:
    response = await auth_client.post(
        "/api/v1/admin/cache/clear", json={}, headers=csrf(auth_client)
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"  # CSRF was fine, role is not


def _health_settings(settings: Settings, **over: Any) -> Settings:
    return settings.model_copy(update=over)


async def test_admin_health_reports_tts_probe(
    admin_client: httpx.AsyncClient,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patched = _health_settings(settings, tts_base_url="http://tts.dotslash.io:8880/v1")
    monkeypatch.setattr(main_module, "get_settings", lambda: patched)
    seen: list[str] = []

    def fake_get(url: str, **kwargs: Any) -> httpx.Response:
        seen.append(url)
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(admin_module.httpx, "get", fake_get)
    response = await admin_client.get("/api/v1/admin/health")
    assert response.status_code == 200
    assert response.json()["tts"] == "ok"
    assert seen == ["http://tts.dotslash.io:8880/health"]  # /v1 stripped

    def refuse(url: str, **kwargs: Any) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=httpx.Request("GET", url))

    monkeypatch.setattr(admin_module.httpx, "get", refuse)
    response = await admin_client.get("/api/v1/admin/health")
    assert response.json()["tts"] == "unreachable"


def test_probe_tts_not_configured_without_base_url() -> None:
    no_base = Settings(_env_file=None, tts_base_url=None)  # type: ignore[call-arg]
    assert admin_module.probe_tts(no_base) == "not_configured"
