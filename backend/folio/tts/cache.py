"""Content-addressed audio cache: keys, paths, synthesis and LRU eviction.

A segment is synthesized once per (model, voice, format, normalized text); the
key deliberately excludes playback speed because speed is a browser
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
from folio.models.audio import Audio, SegmentAudio
from folio.storage import audio_path, ensure_dirs
from folio.tts.text import normalize_speech_text

if TYPE_CHECKING:
    from folio.tts.client import TtsClient

_RECENT = timedelta(minutes=10)  # never evict a file created in the last 10 minutes


def cache_key(model: str, voice: str, fmt: str, text: str) -> str:
    """sha256 of ``model|voice|fmt|text`` (speed is intentionally absent)."""
    return hashlib.sha256(f"{model}|{voice}|{fmt}|{text}".encode()).hexdigest()


def cache_path(settings: Settings, key: str, fmt: str) -> Path:
    return audio_path(settings, key, fmt)


def duration_seconds(path: Path) -> float:
    """Exact duration via mutagen; 0.0 if the file cannot be read."""
    try:
        import mutagen

        return float(mutagen.File(str(path)).info.length)
    except Exception:  # noqa: BLE001 - a bad/missing file just has no known duration
        return 0.0


def get_or_synthesize(
    session: Session, settings: Settings, client: TtsClient, text: str, voice: str
) -> tuple[Audio, bool]:
    """Return ``(audio_row, was_cached)``; a cache hit makes no HTTP call."""
    normalized = normalize_speech_text(text)
    key = cache_key(settings.tts_model, voice, settings.tts_format, normalized)
    row = session.get(Audio, key)
    if row is not None and Path(row.path).exists():
        row.last_played_at = datetime.now(UTC)
        session.commit()
        return row, True

    data, fmt = client.synthesize(normalized, voice)
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
