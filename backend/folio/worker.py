"""Worker entry point: `python -m folio.worker` — claim and run jobs from the queue."""

import logging
import signal
import threading
from collections.abc import Callable

from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.db import SessionLocal
from folio.ingest.pipeline import process_book
from folio.jobs import claim_next, finish, notify
from folio.models.book import Job
from folio.storage import ensure_dirs
from folio.suggest import suggest_for_book
from folio.tts.queue import claim_next_tts, requeue_generating, run_tts_job, urgent_priority

Handler = Callable[[Session, Settings, Job], None]
HANDLERS: dict[str, Handler] = {"ingest": process_book, "suggest": suggest_for_book}

IDLE_S = 0.5
HEARTBEAT_S = 5.0
logger = logging.getLogger(__name__)


def run_job_once(session: Session, settings: Settings) -> bool:
    """Claim and run one import (or other) job; False when none is queued."""
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


def run_tts_once(session: Session, settings: Settings, *, urgent_only: bool) -> bool:
    """Synthesize one queued segment, most urgent first; ``urgent_only`` leaves
    background prefetch (past the lookahead window) alone."""
    row = claim_next_tts(session, max_priority=urgent_priority(settings))
    if row is None and not urgent_only:
        row = claim_next_tts(session)
    if row is None:
        return False
    run_tts_job(session, settings, row)
    return True


def run_once(session: Session, settings: Settings) -> bool:
    """One unit of work in priority order (audio someone waits for, imports,
    background prefetch); False when every queue is empty. The worker itself
    runs these as parallel lanes (``start_lanes``); this is the serial form."""
    return (
        run_tts_once(session, settings, urgent_only=True)
        or run_job_once(session, settings)
        or run_tts_once(session, settings, urgent_only=False)
    )


# The worker's lanes, each a thread with its own DB session. Imports never wait
# for audio (a whole-chapter prefetch is ~1000 sentence requests); one audio lane
# only takes segments someone is waiting for, so a background prefetch never
# holds up the next thing to play. Claims are FOR UPDATE SKIP LOCKED, and the
# TTS client caps requests in flight process-wide at TTS_CONCURRENCY.
LANES: tuple[tuple[str, Callable[[Session, Settings], bool]], ...] = (
    ("imports", run_job_once),
    ("audio-now", lambda session, settings: run_tts_once(session, settings, urgent_only=True)),
    ("audio", lambda session, settings: run_tts_once(session, settings, urgent_only=False)),
)


def _lane(
    name: str, step: Callable[[Session, Settings], bool], settings: Settings, stop: threading.Event
) -> None:
    session = SessionLocal()
    try:
        while not stop.is_set():
            try:
                if not step(session, settings):
                    stop.wait(IDLE_S)
            except Exception:
                logger.exception("%s lane iteration failed; continuing", name)
                session.rollback()
                stop.wait(IDLE_S)
    finally:
        session.close()


def start_lanes(settings: Settings, stop: threading.Event) -> list[threading.Thread]:
    """Start every lane; each finishes its unit in flight once ``stop`` is set."""
    threads = [
        threading.Thread(
            target=_lane, args=(name, step, settings, stop), name=f"worker-{name}", daemon=True
        )
        for name, step in LANES
    ]
    for thread in threads:
        thread.start()
    return threads


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s:%(threadName)s:%(name)s:%(message)s"
    )
    heartbeat = settings.data_dir / ".worker-heartbeat"
    ensure_dirs(heartbeat.parent)
    # A deploy or crash kills the worker mid-synthesis; without this the claimed
    # rows stay "generating" and their listeners wait forever (DECISIONS.md).
    with SessionLocal() as session:
        requeued = requeue_generating(session)
    if requeued:
        logger.info("requeued %d segment(s) a previous worker left generating", requeued)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: stop.set())
    signal.signal(signal.SIGINT, lambda _signum, _frame: stop.set())
    logger.info(
        "worker started (data_dir=%s, lanes=%s)", settings.data_dir, [name for name, _ in LANES]
    )
    threads = start_lanes(settings, stop)
    while not stop.is_set():
        # A dead lane stops the heartbeat: the healthcheck fails and Docker restarts us.
        if all(thread.is_alive() for thread in threads):
            heartbeat.touch()
        stop.wait(HEARTBEAT_S)
    for thread in threads:
        thread.join()
    logger.info("worker stopped")


if __name__ == "__main__":
    main()
