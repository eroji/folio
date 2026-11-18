"""Worker entry point: `python -m folio.worker` — claim and run jobs from the queue."""

import logging
import signal
import time
from collections.abc import Callable
from types import FrameType

from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.db import SessionLocal
from folio.ingest.pipeline import process_book
from folio.jobs import claim_next, finish, notify
from folio.models.book import Job
from folio.storage import ensure_dirs
from folio.tts.queue import claim_next_tts, run_tts_job, urgent_priority

Handler = Callable[[Session, Settings, Job], None]
HANDLERS: dict[str, Handler] = {"ingest": process_book}

IDLE_S = 0.5
_stopping = False
logger = logging.getLogger(__name__)


def _stop(signum: int, frame: FrameType | None) -> None:
    global _stopping
    _stopping = True


def run_once(session: Session, settings: Settings) -> bool:
    """Claim and run one unit of work end to end; False when every queue is empty.

    Audio someone is waiting for (the playing segment and its lookahead) goes
    first (spec: segments needed now come first), then imports, then background
    prefetch: a whole-chapter prefetch is ~1000 sentence requests and kept an
    upload "processing" until it drained. A synthesis in flight always
    finishes before SIGTERM stops the loop.
    """
    row = claim_next_tts(session, max_priority=urgent_priority(settings))
    if row is not None:
        run_tts_job(session, settings, row)
        return True
    job = claim_next(session)
    if job is None:
        row = claim_next_tts(session)
        if row is None:
            return False
        run_tts_job(session, settings, row)
        return True
    handler = HANDLERS.get(job.type)
    if handler is None:
        finish(session, job, error=f"No handler registered for job type '{job.type}'")
    else:
        try:
            handler(session, settings, job)
        except Exception as exc:
            session.rollback()
            logger.exception("job %s (%s) failed", job.id, job.type)
            finish(session, job, error=f"{type(exc).__name__}: {exc}")
        else:
            session.commit()
            finish(session, job)
    notify(
        session,
        {
            "event": "job",
            "job_id": str(job.id),
            "book_id": str(job.book_id) if job.book_id else None,
            "status": job.status,
        },
    )
    return True


def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=logging.INFO)
    heartbeat = settings.data_dir / ".worker-heartbeat"
    ensure_dirs(heartbeat.parent)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    session = SessionLocal()
    logger.info("worker started (data_dir=%s)", settings.data_dir)
    try:
        while not _stopping:
            heartbeat.touch()
            try:
                if not run_once(session, settings):
                    time.sleep(IDLE_S)
            except Exception:
                logger.exception("worker iteration failed; continuing")
                session.rollback()
                time.sleep(IDLE_S)
    finally:
        session.close()
    logger.info("worker stopped")


if __name__ == "__main__":
    main()
