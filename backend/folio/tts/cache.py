"""Content-addressed audio cache: keys, paths, synthesis and LRU eviction.

A segment is synthesized once per (endpoint, model, voice, format, normalized
text, narration instruction, request size when it was split); the key
deliberately excludes playback speed because speed is a browser
``playbackRate`` only (spec: Backend contract). Files live under
``DATA_DIR/audio/<key[:2]>/<key>.<ext>``.
"""

from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.ingest.segment import split_for_speech
from folio.models.audio import Audio, SegmentAudio
from folio.storage import audio_path, ensure_dirs
from folio.tts import TtsError
from folio.tts.adts import adts_duration
from folio.tts.join import join_clips
from folio.tts.text import normalize_speech_text

if TYPE_CHECKING:
    from folio.tts.client import TtsClient

_RECENT = timedelta(minutes=10)  # never evict a file created in the last 10 minutes


def cache_key(
    model: str,
    voice: str,
    fmt: str,
    text: str,
    instructions: str = "",
    endpoint: str = "",
    request_chars: int = 0,
) -> str:
    """sha256 of ``[endpoint|]model|voice|fmt|text[|instructions][|req=N]``.

    The endpoint is part of the seed because two engines serve different audio
    under the same voice id: without it, switching ``TTS_BASE_URL`` replays the
    old engine's clips (and any id the new engine substitutes stays poisoned
    under that id). ``request_chars`` is set only for text synthesized as
    several requests, so clips made as one long generation are replaced. Empty
    instructions/endpoint/request size are not appended, so keys without them
    are unchanged.
    """
    seed = f"{model}|{voice}|{fmt}|{text}"
    if endpoint:
        seed = f"{endpoint}|{seed}"
    if instructions:
        seed += f"|{instructions}"
    if request_chars:
        seed += f"|req={request_chars}"
    return hashlib.sha256(seed.encode()).hexdigest()


def speech_pieces(settings: Settings, normalized: str, language: str) -> list[str]:
    """The requests one normalized text is synthesized as (TTS_REQUEST_CHARS)."""
    return split_for_speech(normalized, language, settings.tts_request_chars)


def speech_cache_key(
    settings: Settings, voice: str, normalized: str, instructions: str, language: str
) -> str:
    """The key ``get_or_synthesize`` files ``normalized`` under; the queue's
    ``prepare`` must compute the same one to find the clip."""
    split = len(speech_pieces(settings, normalized, language)) > 1
    return cache_key(
        settings.tts_model,
        voice,
        settings.tts_format,
        normalized,
        instructions,
        endpoint=(settings.tts_base_url or "").rstrip("/"),
        request_chars=settings.tts_request_chars if split else 0,
    )


def cache_path(settings: Settings, key: str, fmt: str) -> Path:
    return audio_path(settings, key, fmt)


def duration_seconds(path: Path) -> float:
    """Exact duration (ADTS frames counted for AAC, mutagen otherwise); 0.0 if
    the file cannot be read."""
    if path.suffix == ".aac":
        try:
            return adts_duration(path.read_bytes())
        except OSError:
            return 0.0
    try:
        import mutagen

        return float(mutagen.File(str(path)).info.length)
    except Exception:  # noqa: BLE001 - a bad/missing file just has no known duration
        return 0.0


def get_or_synthesize(
    session: Session,
    settings: Settings,
    client: TtsClient,
    text: str,
    voice: str,
    instructions: str = "",
    language: str = "en",
) -> tuple[Audio, bool]:
    """Return ``(audio_row, was_cached)``; a cache hit makes no HTTP call.

    Text longer than ``TTS_REQUEST_CHARS`` goes out as several requests of
    whole sentences, one after another, and the clips are joined into one
    file: a cloned voice drifts and picks up artifacts late in one long
    generation. ``language`` picks the sentence splitter.
    """
    normalized = normalize_speech_text(text)
    key = speech_cache_key(settings, voice, normalized, instructions, language)
    row = session.get(Audio, key)
    if row is not None and Path(row.path).exists():
        row.last_played_at = datetime.now(UTC)
        session.commit()
        return row, True

    clips: list[bytes] = []
    formats: set[str] = set()
    for piece in speech_pieces(settings, normalized, language):
        clip, piece_fmt = client.synthesize(piece, voice, instructions)
        clips.append(clip)
        formats.add(piece_fmt)
    if len(formats) != 1:
        raise TtsError("The TTS engine changed audio format mid-segment.", code="tts_bad_audio")
    fmt = formats.pop()
    data = join_clips(clips, fmt)
    path = cache_path(settings, key, fmt)
    ensure_dirs(path.parent)
    tmp = path.parent / f"{path.name}.part"
    tmp.write_bytes(data)
    os.replace(tmp, path)

    now = datetime.now(UTC)
    if row is None:
        row = Audio(
            cache_key=key,
            path=str(path),
            format=fmt,
            voice=voice,
            model=settings.tts_model,
            duration_s=duration_seconds(path),
            bytes=len(data),
            created_at=now,
            last_played_at=now,
        )
        session.add(row)
    else:  # row existed but the file was evicted: refresh it
        row.path, row.format = str(path), fmt
        row.voice, row.model = voice, settings.tts_model
        row.duration_s, row.bytes = duration_seconds(path), len(data)
        row.created_at, row.last_played_at = now, now
    session.commit()
    return row, False


def evict_if_needed(session: Session, settings: Settings) -> int:
    """Drop least-recently-played files until the cache fits AUDIO_CACHE_MAX_GB.

    Skips files created in the last 10 minutes and any referenced by a
    ``queued``/``generating`` segment_audio row (a lookahead window in flight).
    Returns the number of files removed.
    """
    limit = settings.audio_cache_max_gb * 1024**3
    total = session.scalar(select(func.coalesce(func.sum(Audio.bytes), 0))) or 0
    if total <= limit:
        return 0

    busy = select(SegmentAudio.cache_key).where(
        SegmentAudio.status.in_(("queued", "generating")), SegmentAudio.cache_key.is_not(None)
    )
    cutoff = datetime.now(UTC) - _RECENT
    candidates = session.scalars(
        select(Audio)
        .where(Audio.created_at < cutoff, Audio.cache_key.not_in(busy))
        .order_by(func.coalesce(Audio.last_played_at, Audio.created_at))
    ).all()

    removed = 0
    for row in candidates:
        if total <= limit:
            break
        try:
            Path(row.path).unlink(missing_ok=True)
        except OSError:
            pass  # the row still goes; a stale path must not block eviction
        total -= row.bytes
        session.delete(row)
        removed += 1
    session.commit()
    return removed
