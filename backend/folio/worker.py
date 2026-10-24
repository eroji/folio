"""Worker entry point: `python -m folio.worker` — claim and run jobs from the queue.

Task 8 registers the ``ingest`` handler in ``HANDLERS`` at merge time.
"""

import logging
import signal
import time
from collections.abc import Callable
from types import FrameType

from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.db import SessionLocal
from folio.jobs import claim_next, finish, notify
from folio.models.book import Job
from folio.storage import ensure_dirs

Handler = Callable[[Session, Settings, Job], None]
HANDLERS: dict[str, Handler] = {}

IDLE_S = 0.5
_stopping = False
logger = logging.getLogger(__name__)


def _stop(signum: int, frame: FrameType | None) -> None:
    global _stopping
    _stopping = True


def run_once(session: Session, settings: Settings) -> bool:
    """Claim and run one job end to end; False when the queue is empty."""
    job = claim_next(session)
    if job is None:
        return False
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
            if not run_once(session, settings):
                time.sleep(IDLE_S)
    finally:
        session.close()
    logger.info("worker stopped")


if __name__ == "__main__":
    main()
