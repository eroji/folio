"""Task 7: job queue claims, worker dispatch, storage paths, NOTIFY delivery."""

from __future__ import annotations

import hashlib
import io
import json
import uuid
from typing import Any

import psycopg
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio import jobs, worker
from folio.config import Settings
from folio.db import SessionLocal
from folio.models.book import Job
from folio.storage import audio_path, book_dir, write_original


def _reload(db: Session, job_id: uuid.UUID) -> Job:
    db.expire_all()
    row = db.get(Job, job_id)
    assert row is not None
    return row


def test_enqueue_defaults(db: Session) -> None:
    job = jobs.enqueue(db, "ingest", None)
    db.commit()
    assert job.id is not None
    row = _reload(db, job.id)
    assert row.status == "queued"
    assert row.priority == 100
    assert row.attempts == 0
    assert row.error is None
    assert row.finished_at is None


def test_concurrent_claims_never_return_the_same_job(db: Session) -> None:
    a = jobs.enqueue(db, "ingest", None)
    b = jobs.enqueue(db, "ingest", None)
    db.commit()
    s1, s2 = SessionLocal(), SessionLocal()
    try:
        # s1 holds the lock on a's row without claiming it (simulates a second
        # worker mid-claim); s2 must skip it and take b, never a.
        s1.execute(select(Job).where(Job.id == a.id).with_for_update())
        claimed = jobs.claim_next(s2)
        assert claimed is not None
        assert claimed.id == b.id
        assert claimed.status == "running"
        assert claimed.attempts == 1
        s1.rollback()
    finally:
        s1.close()
        s2.close()
    assert _reload(db, a.id).status == "queued"
    assert _reload(db, b.id).status == "running"


def test_claim_respects_priority_ordering(db: Session) -> None:
    low = jobs.enqueue(db, "ingest", None, priority=200)
    high = jobs.enqueue(db, "ingest", None, priority=10)
    db.commit()
    s = SessionLocal()
    try:
        first = jobs.claim_next(s)
        assert first is not None and first.id == high.id
        second = jobs.claim_next(s)
        assert second is not None and second.id == low.id
        assert jobs.claim_next(s) is None
    finally:
        s.close()


def test_run_once_marks_done_and_calls_handler(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[uuid.UUID] = []
    monkeypatch.setitem(worker.HANDLERS, "ok", lambda s, st, j: seen.append(j.id))
    job = jobs.enqueue(db, "ok", None)
    db.commit()
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()
    assert seen == [job.id]
    row = _reload(db, job.id)
    assert row.status == "done" and row.attempts == 1 and row.error is None
    assert row.finished_at is not None


def test_handler_exception_fails_job_with_attempts_one(
    db: Session, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(session: Session, st: Settings, j: Job) -> None:
        raise RuntimeError("extraction exploded")

    monkeypatch.setitem(worker.HANDLERS, "boom", boom)
    job = jobs.enqueue(db, "boom", None)
    db.commit()
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()
    row = _reload(db, job.id)
    assert row.status == "failed"
    assert row.attempts == 1
    assert "extraction exploded" in (row.error or "")


def test_unknown_job_type_fails_with_readable_error(db: Session, settings: Settings) -> None:
    assert "nope" not in worker.HANDLERS
    job = jobs.enqueue(db, "nope", None)
    db.commit()
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is True
    finally:
        s.close()
    row = _reload(db, job.id)
    assert row.status == "failed"
    assert "nope" in (row.error or "")


def test_run_once_returns_false_on_empty_queue(db: Session, settings: Settings) -> None:
    s = SessionLocal()
    try:
        assert worker.run_once(s, settings) is False
    finally:
        s.close()


def test_write_original_hashes_streams_and_paths(settings: Settings) -> None:
    book_id = uuid.uuid4()
    data = b"ebook bytes" * 120_000  # > 1 MiB: exercises the chunked loop
    path, sha, size = write_original(settings, book_id, ".epub", io.BytesIO(data))
    assert sha == hashlib.sha256(data).hexdigest()
    assert size == len(data)
    assert path == book_dir(settings, book_id) / "original.epub"
    assert path.is_relative_to(settings.data_dir.resolve())
    assert path.read_bytes() == data


def test_write_original_rejects_traversal(settings: Settings) -> None:
    with pytest.raises(ValueError):
        write_original(settings, "../../etc/passwd", "epub", io.BytesIO(b"x"))  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        write_original(settings, uuid.uuid4(), "../evil", io.BytesIO(b"x"))
    with pytest.raises(ValueError):
        write_original(settings, uuid.uuid4(), "a" * 20, io.BytesIO(b"x"))


def test_audio_path_rejects_non_hex_keys(settings: Settings) -> None:
    key = hashlib.sha256(b"model|voice|opus|text").hexdigest()
    path = audio_path(settings, key, "opus")
    assert path == settings.data_dir / "audio" / key[:2] / f"{key}.opus"
    with pytest.raises(ValueError):
        audio_path(settings, "../../etc/passwd", "opus")
    with pytest.raises(ValueError):
        audio_path(settings, key, "op.us/../sh")


def test_notify_delivers_to_a_listening_connection(settings: Settings, db: Session) -> None:
    dsn = settings.database_url.replace("+psycopg", "")
    payload: dict[str, Any] = {"event": "job", "status": "done", "job_id": str(uuid.uuid4())}
    with psycopg.connect(dsn, autocommit=True) as listener:
        listener.execute("LISTEN folio_events")
        s = SessionLocal()
        try:
            jobs.notify(s, payload)
        finally:
            s.close()
        payloads = [n.payload for n in listener.notifies(timeout=5.0)]
        assert payloads and json.loads(payloads[0])["event"] == "job"
