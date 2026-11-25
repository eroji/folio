"""Task A: pronunciation rules API, audio invalidation, TTS integration."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from factories import make_user
from mock_tts import SILENT_OPUS
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.main import create_app
from folio.models import Audio, Book, Chapter, PronunciationRule, Segment, SegmentAudio, User
from folio.tts import TtsClient
from folio.tts import queue as queue_module
from folio.tts.cache import cache_key, cache_path
from folio.tts.narration import narration_prompt
from folio.tts.pronunciation import apply_rules
from folio.tts.queue import claim_next_tts, invalidate_book_audio, prepare, run_tts_job
from folio.tts.text import normalize_speech_text

BOOK_TEXT = "The nginx server, version 1 nginx."


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _url(book_id: UUID, rule_id: UUID | None = None) -> str:
    base = f"/api/v1/books/{book_id}/pronunciation"
    return base if rule_id is None else f"{base}/{rule_id}"


def _book(db: Session, *, uploaded_by: UUID | None = None, text: str = BOOK_TEXT) -> Book:
    book = Book(title="Pron Book", language="en", status="ready", uploaded_by=uploaded_by)
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="Chapter 0", char_count=len(text))
    db.add(chapter)
    db.flush()
    db.add(Segment(chapter_id=chapter.id, idx=0, text=text, char_start=0, char_end=len(text)))
    db.commit()
    return book


def _testuser(db: Session) -> User:
    db.expire_all()
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    return user


def _segment(db: Session, book: Book) -> Segment:
    segment = db.scalar(
        select(Segment)
        .join(Chapter, Segment.chapter_id == Chapter.id)
        .where(Chapter.book_id == book.id)
    )
    assert segment is not None
    return segment


async def test_crud_roundtrip(admin_client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db)
    created = await admin_client.post(
        _url(book.id),
        json={"match": "nginx", "say": "engine X", "whole_word": True},
        headers=csrf(admin_client),
    )
    assert created.status_code == 200, created.text
    rule = created.json()["rule"]
    assert rule["match"] == "nginx" and rule["say"] == "engine X"
    assert rule["whole_word"] is True
    assert rule["after_number"] is False and rule["case_sensitive"] is False

    listed = await admin_client.get(_url(book.id))
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()["items"]] == [rule["id"]]

    patched = await admin_client.patch(
        _url(book.id, UUID(rule["id"])),
        json={"say": "engine eleven", "case_sensitive": True},
        headers=csrf(admin_client),
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["rule"]["say"] == "engine eleven"
    assert patched.json()["rule"]["case_sensitive"] is True
    assert patched.json()["rule"]["whole_word"] is True  # untouched

    deleted = await admin_client.delete(_url(book.id, UUID(rule["id"])), headers=csrf(admin_client))
    assert deleted.status_code == 204
    assert (await admin_client.get(_url(book.id))).json()["items"] == []


async def test_permissions_uploader_other_and_admin(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    own = _book(db, uploaded_by=_testuser(db).id)
    foreign = _book(db, uploaded_by=make_user(db, username="someoneelse").id)

    ok = await auth_client.post(
        _url(own.id), json={"match": "a", "say": "b"}, headers=csrf(auth_client)
    )
    assert ok.status_code == 200, ok.text
    forbidden = await auth_client.post(
        _url(foreign.id), json={"match": "a", "say": "b"}, headers=csrf(auth_client)
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "forbidden"
    assert (await auth_client.get(_url(foreign.id))).status_code == 403

    # A second client: auth_client/admin_client share one cookie jar in conftest.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="https://testserver"
    ) as admin:
        await admin.post("/api/v1/test/login", json={"username": "testadmin", "role": "admin"})
        as_admin = await admin.post(
            _url(foreign.id), json={"match": "a", "say": "b"}, headers=csrf(admin)
        )
        assert as_admin.status_code == 200, as_admin.text


async def test_validation_trims_rejects_empty_and_duplicates(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _book(db, uploaded_by=_testuser(db).id)
    for bad in (
        {"match": "", "say": "x"},
        {"match": "   ", "say": "x"},
        {"match": "x", "say": " "},
        {"match": "x" * 201, "say": "x"},
        {"match": "x", "say": "x" * 201},
    ):
        response = await auth_client.post(_url(book.id), json=bad, headers=csrf(auth_client))
        assert response.status_code == 422, bad

    created = await auth_client.post(
        _url(book.id),
        json={"match": " nginx ", "say": " engine X "},
        headers=csrf(auth_client),
    )
    assert created.status_code == 200, created.text
    assert created.json()["rule"]["match"] == "nginx"  # trimmed
    assert created.json()["rule"]["say"] == "engine X"

    duplicate = await auth_client.post(
        _url(book.id), json={"match": "NGINX", "say": "again"}, headers=csrf(auth_client)
    )
    assert duplicate.status_code == 422
    assert duplicate.json()["error"]["code"] == "validation_failed"

    rule_id = UUID(created.json()["rule"]["id"])
    patch_dup = await auth_client.patch(
        _url(book.id, rule_id), json={"match": "NgInx"}, headers=csrf(auth_client)
    )
    assert patch_dup.status_code == 200  # patching a rule to its own match is not a duplicate

    other_rule = await auth_client.post(
        _url(book.id), json={"match": "tomcat", "say": "tom cat"}, headers=csrf(auth_client)
    )
    clash = await auth_client.patch(
        _url(book.id, UUID(other_rule.json()["rule"]["id"])),
        json={"match": "NGINX"},
        headers=csrf(auth_client),
    )
    assert clash.status_code == 422  # colliding with a different rule


async def test_csrf_and_not_found(auth_client: httpx.AsyncClient, db: Session) -> None:
    book = _book(db, uploaded_by=_testuser(db).id)
    no_csrf = await auth_client.post(_url(book.id), json={"match": "a", "say": "b"})
    assert no_csrf.status_code == 403
    assert no_csrf.json()["error"]["code"] == "csrf_failed"

    missing_book = await auth_client.post(
        _url(uuid4()), json={"match": "a", "say": "b"}, headers=csrf(auth_client)
    )
    assert missing_book.status_code == 404

    created = await auth_client.post(
        _url(book.id), json={"match": "a", "say": "b"}, headers=csrf(auth_client)
    )
    rule_id = UUID(created.json()["rule"]["id"])
    other = _book(db, uploaded_by=_testuser(db).id)
    responses = [
        await auth_client.patch(
            _url(other.id, rule_id), json={"say": "x"}, headers=csrf(auth_client)
        ),
        await auth_client.delete(_url(other.id, rule_id), headers=csrf(auth_client)),
        await auth_client.patch(
            _url(book.id, uuid4()), json={"say": "x"}, headers=csrf(auth_client)
        ),
        await auth_client.delete(_url(book.id, uuid4()), headers=csrf(auth_client)),
    ]
    assert [r.status_code for r in responses] == [404] * 4  # cross-book or unknown rule


async def test_rule_changes_delete_the_books_audio_rows(
    auth_client: httpx.AsyncClient,
    db: Session,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    book = _book(db, uploaded_by=_testuser(db).id)
    prepare(db, settings, book, _segment(db, book).id, count=0, voice="ashley-en")
    assert db.scalar(select(func.count()).select_from(SegmentAudio)) == 1

    frames: list[dict[str, Any]] = []
    monkeypatch.setattr(queue_module, "notify", lambda _db, payload: frames.append(payload))
    created = await auth_client.post(
        _url(book.id), json={"match": "nginx", "say": "engine X"}, headers=csrf(auth_client)
    )
    assert created.status_code == 200
    assert db.scalar(select(func.count()).select_from(SegmentAudio)) == 0
    assert frames == [
        {"event": "audio", "book_id": str(book.id), "segment_id": None, "status": "invalidated"}
    ]

    # A different book's queue rows survive.
    other = _book(db, uploaded_by=_testuser(db).id)
    prepare(db, settings, other, _segment(db, other).id, count=0, voice="ashley-en")
    deleted = await auth_client.delete(
        _url(book.id, UUID(created.json()["rule"]["id"])), headers=csrf(auth_client)
    )
    assert deleted.status_code == 204
    assert db.scalar(select(func.count()).select_from(SegmentAudio)) == 1


def _seed_audio(db: Session, settings: Settings, key: str) -> None:
    """Put a clip in the cache under ``key`` the way get_or_synthesize would."""
    path = cache_path(settings, key, settings.tts_format)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(SILENT_OPUS)
    db.add(
        Audio(
            cache_key=key,
            path=str(path),
            format=settings.tts_format,
            voice="ashley-en",
            model=settings.tts_model,
            duration_s=1.0,
            bytes=len(SILENT_OPUS),
        )
    )
    db.commit()


def test_cache_key_changes_with_a_rule_and_prepare_requeues(
    db: Session, settings: Settings
) -> None:
    book = _book(db)
    segment = _segment(db, book)
    raw_key = cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        normalize_speech_text(segment.text),
        narration_prompt(db, "ashley-en", book.genre),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    _seed_audio(db, settings, raw_key)
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "ready"  # cache hit without any rule

    rule = PronunciationRule(book_id=book.id, match="nginx", say="engine X")
    db.add(rule)
    db.commit()
    corrected_key = cache_key(
        settings.tts_model,
        "ashley-en",
        settings.tts_format,
        normalize_speech_text(apply_rules(segment.text, [rule])),
        narration_prompt(db, "ashley-en", book.genre),
        endpoint=(settings.tts_base_url or "").rstrip("/"),
    )
    assert corrected_key != raw_key  # the rule changes what the segment hashes to

    invalidate_book_audio(db, book.id)
    assert db.scalar(select(func.count()).select_from(SegmentAudio)) == 0
    window = prepare(db, settings, book, segment.id, count=0, voice="ashley-en")
    assert window[0][1].status == "queued"  # re-queued: the old clip no longer matches


class _FakeClient:
    """TtsClient stand-in whose transport is a MockTransport handler."""

    def __init__(self, _settings: Settings, handler: Any) -> None:
        real = TtsClient(Settings(_env_file=None, tts_base_url="http://tts.test/v1"))  # type: ignore[call-arg]
        real._client = httpx.Client(transport=httpx.MockTransport(handler))
        self._impl = real

    def __enter__(self) -> Any:
        return self._impl

    def __exit__(self, *exc: object) -> None:
        self._impl.close()


def test_run_tts_job_synthesizes_the_corrected_text(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    book = _book(db)
    db.add(PronunciationRule(book_id=book.id, match="nginx", say="engine X"))
    db.commit()
    prepare(db, settings, book, _segment(db, book).id, count=0, voice="ashley-en")
    row = claim_next_tts(db)
    assert row is not None

    spoken: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body: dict[str, Any] = json.loads(request.content)
        spoken.append(str(body["input"]))
        return httpx.Response(200, content=SILENT_OPUS, headers={"content-type": "audio/ogg"})

    monkeypatch.setattr(queue_module, "TtsClient", lambda _s, **_kw: _FakeClient(_s, handler))
    run_tts_job(db, settings, row)

    assert row.status == "ready", row.error
    assert spoken == ["The engine X server, version 1 engine X."]
