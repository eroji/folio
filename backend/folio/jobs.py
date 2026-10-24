"""Postgres-backed job queue (spec: ``jobs`` table + LISTEN/NOTIFY, no Redis)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from folio.models.book import Job


def enqueue(db: Session, job_type: str, book_id: UUID | None, priority: int = 100) -> Job:
    """Create a ``queued`` job. The caller commits with its own rows."""
    job = Job(type=job_type, book_id=book_id, priority=priority)
    db.add(job)
    db.flush()
    return job


def claim_next(db: Session) -> Job | None:
    """Claim the highest-priority queued job, or None if the queue is empty.

    ``FOR UPDATE SKIP LOCKED`` makes concurrent workers never see the same
    row: a job locked by another worker mid-claim is skipped, not blocked on.
    """
    job = (
        db.execute(
            select(Job)
            .where(Job.status == "queued")
            .order_by(Job.priority, Job.created_at, Job.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .first()
    )
    if job is None:
        db.commit()  # end the read transaction so no locks linger
        return None
    job.status = "running"
    job.attempts += 1
    db.commit()
    return job


def finish(db: Session, job: Job, error: str | None = None) -> None:
    """Close a claimed job: ``done``, or ``failed`` with a readable error."""
    job.status = "failed" if error else "done"
    job.error = error
    job.finished_at = datetime.now(UTC)
    db.commit()


def notify(db: Session, payload: dict[str, Any]) -> None:
    """Push a JSON payload to API SSE listeners on the ``folio_events`` channel.

    Commits first: Postgres delivers NOTIFY at transaction end, so a pending
    transaction would silently swallow the event.
    """
    db.execute(
        text("SELECT pg_notify('folio_events', :payload)"),
        {"payload": json.dumps(payload)},
    )
    db.commit()
