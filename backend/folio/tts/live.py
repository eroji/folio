"""Live start: play a segment while the engine is still making it.

A narrator change mid-play lands on a segment the new voice has no clip for,
and a whole-segment request (~800 characters) takes as long as ~35 s before
anything can play. Instead, the segment is cut at the sentence the listener is
on; the rest is requested as a raw PCM stream (fish-s2-openai streams PCM
only, first audio in ~0.2 s), encoded on the fly by ffmpeg to the clip format
and sent to the player as it arrives. The start of the segment is made after,
and the two become the segment's one cached clip, so nothing is generated twice.

A live start is one background thread per (segment, voice) in the API process;
every GET of its URL replays it from the first byte. Its queue row is
``streaming``: the worker leaves it alone (unless it is abandoned, see
``claim_next_tts``), ``prepare`` keeps it, and ``cancel_pending`` deleting it
(a narrator change) stops the stream and the engine request.
ponytail: sessions live in one process; several API workers would need a
shared store (and a sticky route) for the GET to find its session.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.db import SessionLocal
from folio.ingest.segment import speech_pieces
from folio.integrations import SENTENCE_REQUEST_CHARS, effective_tts_settings
from folio.models import Audio, Book, SegmentAudio
from folio.storage import ensure_dirs
from folio.tts.cache import cache_path, duration_seconds, single_request_key, speech_cache_key
from folio.tts.encode import DEFAULT_PCM_RATE, ENCODE, can_encode, encode_pcm, ffmpeg_args
from folio.tts.hangup import hang_up_client
from folio.tts.narration import engine_instructions
from folio.tts.pronunciation import apply_rules
from folio.tts.queue import PRIORITY_NOW, _notify, _rules, prepare
from folio.tts.text import normalize_speech_text

logger = logging.getLogger(__name__)

# The POST answers once audio flows (or the engine refused): the player sets
# the URL only when there is something to play.
FIRST_AUDIO_TIMEOUT_S = 15.0
# How often a running stream checks its row still exists (a narrator change).
CANCEL_POLL_S = 0.25
# A finished stream stays replayable this long (Safari re-requests media).
KEEP_FINISHED_S = 120.0


class _Stop(Exception):
    """The row is gone (a narrator or text change): stop quietly."""


@dataclass
class _Live:
    id: str
    segment_id: UUID
    voice: str
    start: float  # share of the segment's text the stream begins at
    media_type: str
    chunks: list[bytes] = field(default_factory=list)
    done: bool = False
    failed: bool = False
    first: threading.Event = field(default_factory=threading.Event)
    cond: threading.Condition = field(default_factory=threading.Condition)
    ended_at: float | None = None
    # The whole job (the start of the segment and the cached clip) is over.
    finished: bool = False

    def add(self, data: bytes) -> None:
        with self.cond:
            self.chunks.append(data)
            self.cond.notify_all()
        self.first.set()

    def end(self, *, failed: bool = False) -> None:
        with self.cond:
            self.done = True
            self.failed = failed
            self.ended_at = time.monotonic()
            self.cond.notify_all()
        self.first.set()


_LIVE: dict[str, _Live] = {}
_LIVE_LOCK = threading.Lock()


def _answer(live: _Live) -> dict[str, Any]:
    return {
        "status": "streaming",
        "url": f"/api/v1/audio/live/{live.id}",
        "from": live.start,
        "voice": live.voice,
    }


def _forget_finished() -> None:
    now = time.monotonic()
    with _LIVE_LOCK:
        for key in [
            k
            for k, live in _LIVE.items()
            if live.ended_at is not None and now - live.ended_at > KEEP_FINISHED_S
        ]:
            del _LIVE[key]


def _running(segment_id: UUID, voice: str) -> _Live | None:
    with _LIVE_LOCK:
        return next(
            (
                live
                for live in _LIVE.values()
                if live.segment_id == segment_id and live.voice == voice and not live.finished
            ),
            None,
        )


def _claim(session: Session, row: SegmentAudio) -> UUID:
    """Make the (segment, voice) row this live start's; returns its id.

    A queued or failed row is taken in place, but only while it still is (the
    worker may claim it a moment after prepare queued it). A row the worker is
    generating, or a ``streaming`` claim with no running session, is replaced:
    the worker sees its row gone and stops (``run_tts_job``).
    """
    claimed = session.execute(
        update(SegmentAudio)
        .where(SegmentAudio.id == row.id, SegmentAudio.status.in_(("queued", "failed")))
        .values(status="streaming", error=None, priority=PRIORITY_NOW)
        .returning(SegmentAudio.id)
    ).scalar_one_or_none()
    if claimed is None:
        session.execute(delete(SegmentAudio).where(SegmentAudio.id == row.id))
        claimed = uuid4()
        session.add(
            SegmentAudio(
                id=claimed,
                segment_id=row.segment_id,
                voice=row.voice,
                status="streaming",
                priority=PRIORITY_NOW,
            )
        )
    session.commit()
    return claimed


def start_live(
    session: Session,
    settings: Settings,
    book: Book,
    segment_id: UUID,
    at: float,
    voice: str | None = None,
    user_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start (or join) the live start of a segment from the sentence at share ``at``.

    ``{"status": "ready"}`` when the clip already exists; ``"unavailable"``
    when this format cannot be streamed here or the engine refused (the row is
    then queued for the worker); else ``"streaming"`` with the URL to play and
    ``from``, the share of the text the stream begins at.
    """
    _forget_finished()
    settings = effective_tts_settings(session, settings)
    ((segment, row),) = prepare(session, settings, book, segment_id, 0, voice, user_settings)
    voice = row.voice
    if row.status == "ready":
        return {"status": "ready", "voice": voice}
    if not can_encode(settings.tts_format) or not settings.tts_base_url:
        return {"status": "unavailable", "voice": voice}
    running = _running(segment.id, voice)
    if running is not None and row.status == "streaming":
        return _answer(running)

    rules = _rules(session, book.id)
    normalized = normalize_speech_text(apply_rules(segment.text, rules))
    instructions = engine_instructions(session, settings, voice, book.genre, book.delivery_note)
    cut = 0
    for piece in speech_pieces(normalized, book.language, SENTENCE_REQUEST_CHARS):
        if normalized and piece.char_start / len(normalized) <= at + 1e-9:
            cut = piece.char_start
    row_id = _claim(session, row)

    live = _Live(
        id=uuid4().hex,
        segment_id=segment.id,
        voice=voice,
        start=round(cut / len(normalized), 6) if normalized else 0.0,
        media_type=ENCODE[settings.tts_format][1],
    )
    with _LIVE_LOCK:
        _LIVE[live.id] = live
    job = _Job(
        live=live,
        settings=settings,
        row_id=row_id,
        book_id=str(book.id),
        key=speech_cache_key(settings, voice, normalized, instructions, book.language),
        text_key=single_request_key(settings, voice, normalized, instructions),
        head=normalized[:cut].strip(),
        tail=normalized[cut:].strip(),
        instructions=instructions,
    )
    threading.Thread(target=job.run, name=f"live-{live.id[:8]}", daemon=True).start()
    live.first.wait(FIRST_AUDIO_TIMEOUT_S)
    if live.failed and not live.chunks:
        return {"status": "unavailable", "voice": voice}
    return _answer(live)


def live_stream(live_id: str) -> tuple[Iterator[bytes], str] | None:
    """The live start's bytes from the first one, following until it ends."""
    with _LIVE_LOCK:
        live = _LIVE.get(live_id)
    if live is None:
        return None

    def follow() -> Iterator[bytes]:
        sent = 0
        while True:
            with live.cond:
                while len(live.chunks) <= sent and not live.done:
                    live.cond.wait(1.0)
                fresh = live.chunks[sent:]
                sent = len(live.chunks)
                finished = live.done
            if fresh:
                yield b"".join(fresh)
            if finished and sent >= len(live.chunks):
                return

    return follow(), live.media_type


@dataclass
class _Job:
    live: _Live
    settings: Settings
    row_id: UUID
    book_id: str
    key: str
    text_key: str
    head: str
    tail: str
    instructions: str
    # Set by the watcher once the row is gone; it also hangs up the engine.
    stop: threading.Event = field(default_factory=threading.Event)

    def run(self) -> None:
        db = SessionLocal()
        try:
            self._run(db)
        except _Stop:
            logger.info("live start %s stopped: its segment was cancelled", self.live.id[:8])
            self.live.end()
        except Exception as exc:  # noqa: BLE001 - the queue makes it instead
            logger.warning("live start %s failed: %s", self.live.id[:8], exc)
            db.rollback()
            self._requeue(db)
            self.live.end(failed=True)
        finally:
            self.live.finished = True
            db.close()

    def _wanted(self, db: Session) -> bool:
        status = db.scalar(select(SegmentAudio.status).where(SegmentAudio.id == self.row_id))
        db.rollback()  # end the read: never idle in a transaction for a whole stream
        return status == "streaming"

    def _requeue(self, db: Session) -> None:
        row = db.get(SegmentAudio, self.row_id)
        if row is not None and row.status == "streaming":
            row.status, row.priority = "queued", PRIORITY_NOW
            db.commit()
            _notify(db, self.book_id, row.segment_id, "queued")

    def _body(self, text: str, stream: bool) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.settings.tts_model,
            "voice": self.live.voice,
            "input": text,
            "response_format": "pcm",
            "stream": stream,
            "speed": 1.0,
        }
        if self.instructions:
            body["instructions"] = self.instructions
        return body

    def _run(self, db: Session) -> None:
        headers = {}
        if self.settings.tts_api_key:
            headers["Authorization"] = f"Bearer {self.settings.tts_api_key}"
        url = f"{(self.settings.tts_base_url or '').rstrip('/')}/audio/speech"
        done = threading.Event()
        client, hang_up = hang_up_client(60.0, headers)
        with client:
            watcher = threading.Thread(target=self._watch, args=(hang_up, done), daemon=True)
            watcher.start()
            try:
                tail_pcm, rate = self._stream_tail(client, url)
                self.live.end()  # the listener has the rest of the segment
                head_pcm = self._stream_head(client, url) if self.head else b""
            except httpx.HTTPError:
                if self.stop.is_set():
                    raise _Stop from None  # the watcher hung up
                raise
            finally:
                done.set()
                watcher.join()
        if self.stop.is_set() or not self._wanted(db):
            raise _Stop
        self._store(db, head_pcm[: len(head_pcm) // 2 * 2], tail_pcm, rate)

    def _watch(self, hang_up: Callable[[], None], done: threading.Event) -> None:
        """Check the row while the engine works, and hang up once it is gone
        (a narrator change), even before the engine has answered: a busy
        engine queues the request, and no chunk arrives to notice it by."""
        db = SessionLocal()
        try:
            while not done.wait(CANCEL_POLL_S):
                if not self._wanted(db):
                    self.stop.set()
                    hang_up()
                    return
        finally:
            db.close()

    def _stream_tail(self, client: httpx.Client, url: str) -> tuple[bytes, int]:
        """Stream the rest of the segment to the listener; returns its PCM."""
        with client.stream("POST", url, json=self._body(self.tail, stream=True)) as response:
            if response.status_code != 200:
                raise RuntimeError(f"the engine answered {response.status_code}")
            rate = int(response.headers.get("x-sample-rate") or DEFAULT_PCM_RATE)
            encoder = subprocess.Popen(
                ffmpeg_args(rate, self.settings.tts_format, live=True),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )
            assert encoder.stdin is not None and encoder.stdout is not None
            out = encoder.stdout
            reader = threading.Thread(target=self._read, args=(out,), daemon=True)
            reader.start()
            pcm = bytearray()
            try:
                for chunk in response.iter_bytes():
                    pcm += chunk
                    encoder.stdin.write(chunk)
                    encoder.stdin.flush()
                    if self.stop.is_set():
                        raise _Stop  # leaving the block hangs up: the engine stops
                encoder.stdin.close()
                reader.join()
                if encoder.wait() != 0:
                    raise RuntimeError("ffmpeg could not encode the stream")
            except BaseException:
                encoder.kill()
                encoder.wait()
                reader.join(timeout=5)
                raise
        return bytes(pcm[: len(pcm) // 2 * 2]), rate

    def _stream_head(self, client: httpx.Client, url: str) -> bytes:
        """The start of the segment, streamed too: a cancel hangs up, and the
        engine stops (it finishes a plain request whoever is waiting)."""
        with client.stream("POST", url, json=self._body(self.head, stream=True)) as response:
            if response.status_code != 200:
                raise RuntimeError(f"the engine answered {response.status_code}")
            pcm = bytearray()
            for chunk in response.iter_bytes():
                pcm += chunk
                if self.stop.is_set():
                    raise _Stop
        return bytes(pcm)

    def _read(self, out: Any) -> None:
        while data := out.read1(16384):
            self.live.add(data)

    def _store(self, db: Session, head_pcm: bytes, tail_pcm: bytes, rate: int) -> None:
        """Encode the whole segment once and file it as its cached clip."""
        encoded = encode_pcm(head_pcm + tail_pcm, rate, self.settings.tts_format)
        fmt = self.settings.tts_format
        path = cache_path(self.settings, self.key, fmt)
        ensure_dirs(path.parent)
        tmp = path.parent / f"{path.name}.part"
        tmp.write_bytes(encoded)
        os.replace(tmp, path)
        marks = (
            [[0.0, 0.0], [self.live.start, round(len(head_pcm) / 2 / rate, 3)]]
            if head_pcm
            else None
        )
        now = datetime.now(UTC)
        audio = db.get(Audio, self.key)
        if audio is None:
            audio = Audio(cache_key=self.key, created_at=now)
            db.add(audio)
        audio.path, audio.format = str(path), fmt
        audio.voice, audio.model = self.live.voice, self.settings.tts_model
        audio.duration_s, audio.bytes = duration_seconds(path), len(encoded)
        audio.text_key, audio.marks = self.text_key, marks
        audio.last_played_at = now
        db.flush()
        row = db.get(SegmentAudio, self.row_id)
        if row is None or row.status != "streaming":
            db.commit()  # cancelled at the last moment: the clip still serves a switch back
            return
        row.cache_key, row.status, row.error = self.key, "ready", None
        db.commit()
        _notify(db, self.book_id, row.segment_id, "ready")
