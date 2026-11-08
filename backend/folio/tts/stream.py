"""HLS book stream: the cached AAC clips of a book, from a given segment on,
as one continuous track (spec: TTS → iOS lock-screen playback, DECISIONS.md).

Safari fetches the playlist and its segments itself, so playback carries on
across clip and chapter boundaries while a locked iPhone has frozen the page.
The playlist lists the contiguous run of generated clips from ``from`` and
grows (EVENT) until the end of the book, when it gains EXT-X-ENDLIST.
Timestamps are relative to ``from``; each segment is the cached clip prefixed
with the ID3 PRIV timestamp that HLS packed audio requires.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.errors import ApiError
from folio.models import Audio, Book, Chapter, Segment, SegmentAudio
from folio.tts.queue import prepare

logger = logging.getLogger(__name__)

STREAM_FORMAT = "aac"
# Constant so a growing playlist never changes it (RFC 8216 §4.3.3.1); clips
# run ~45 s and a longer one only raises it.
MIN_TARGET_DURATION_S = 60
_TS_OWNER = b"com.apple.streaming.transportStreamTimestamp\x00"


@dataclass(frozen=True)
class StreamEntry:
    segment_id: UUID
    chapter_id: UUID
    path: str
    start: float  # seconds from the stream origin
    duration: float


@dataclass(frozen=True)
class StreamWindow:
    voice: str
    origin: UUID
    entries: list[StreamEntry]
    complete: bool  # every segment to the end of the book is listed
    next_missing: UUID | None  # the first segment not generated yet


def _syncsafe(n: int) -> bytes:
    return bytes(((n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F))


def hls_timestamp_tag(start_s: float) -> bytes:
    """ID3v2.4 tag with the PRIV frame that dates a packed-audio segment, in
    90 kHz units of a 33-bit MPEG-2 timestamp (RFC 8216 §3.4)."""
    ts = round(start_s * 90_000) & ((1 << 33) - 1)
    payload = _TS_OWNER + ts.to_bytes(8, "big")
    frame = b"PRIV" + _syncsafe(len(payload)) + b"\x00\x00" + payload
    return b"ID3\x04\x00\x00" + _syncsafe(len(frame)) + frame


def stream_window(session: Session, book: Book, voice: str, origin: UUID) -> StreamWindow:
    """The listed run from ``origin``: ready AAC clips in reading order, no gaps."""
    order = session.execute(
        select(Segment.id, Segment.chapter_id)
        .join(Chapter, Segment.chapter_id == Chapter.id)
        .where(Chapter.book_id == book.id, Chapter.excluded.is_(False))
        .order_by(Chapter.idx, Segment.idx)
    ).all()
    start = next((i for i, (sid, _) in enumerate(order) if sid == origin), None)
    if start is None:
        raise ApiError("not_found", "Segment not found.", 404)
    clips = {
        sid: (path, fmt, duration)
        for sid, path, fmt, duration in session.execute(
            select(SegmentAudio.segment_id, Audio.path, Audio.format, Audio.duration_s)
            .join(Audio, Audio.cache_key == SegmentAudio.cache_key)
            .join(Segment, Segment.id == SegmentAudio.segment_id)
            .join(Chapter, Segment.chapter_id == Chapter.id)
            .where(
                Chapter.book_id == book.id,
                SegmentAudio.voice == voice,
                SegmentAudio.status == "ready",
            )
        ).all()
    }
    entries: list[StreamEntry] = []
    at = 0.0
    for sid, chapter_id in order[start:]:
        clip = clips.get(sid)
        if clip is None or clip[1] != STREAM_FORMAT or clip[2] <= 0:
            return StreamWindow(voice, origin, entries, complete=False, next_missing=sid)
        entries.append(StreamEntry(sid, chapter_id, clip[0], at, clip[2]))
        at += clip[2]
    return StreamWindow(voice, origin, entries, complete=True, next_missing=None)


def keep_generating(session: Session, settings: Settings, book: Book, window: StreamWindow) -> None:
    """Queue the first missing segment (needed now) and its lookahead: on a
    locked phone only the media player is polling, not the page's top-up."""
    if window.next_missing is None:
        return
    try:
        prepare(session, settings, book, window.next_missing, None, window.voice)
    except SQLAlchemyError:
        # A side effect only: the player's own prepare and the next poll retry.
        session.rollback()
        logger.warning("stream top-up failed book=%s", book.id, exc_info=True)


def render_playlist(window: StreamWindow) -> str:
    longest = max((e.duration for e in window.entries), default=0.0)
    query = f"voice={quote(window.voice)}&from={window.origin}"
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{max(MIN_TARGET_DURATION_S, math.ceil(longest))}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:EVENT",
        # Start at the origin, not near the "live" edge of a growing playlist.
        "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES",
    ]
    for n, entry in enumerate(window.entries):
        lines += [f"#EXTINF:{entry.duration:.6f},", f"stream/{n}.aac?{query}"]
    if window.complete:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"
