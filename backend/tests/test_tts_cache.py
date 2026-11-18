"""Cache keys, synthesis (no HTTP on hit), duration, and LRU eviction."""

from __future__ import annotations

import hashlib
import inspect
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.models import Audio, Book, Chapter, Segment, SegmentAudio
from folio.tts import cache_key, cache_path, duration_seconds, evict_if_needed, get_or_synthesize
from folio.tts.cache import single_request_key, speech_cache_key

sys_path = Path(__file__).resolve().parents[1]


class _CountingClient:
    def __init__(self, fmt: str = "opus") -> None:
        from mock_tts import SILENT_OPUS

        self.data = SILENT_OPUS
        self.fmt = fmt
        self.calls = 0
        self.texts: list[str] = []

    def synthesize(
        self, text: str, _voice: str, _instructions: str | None = None
    ) -> tuple[bytes, str]:
        self.calls += 1
        self.texts.append(text)
        return self.data, self.fmt


def test_cache_key_is_stable_and_speed_free() -> None:
    a = cache_key("tts", "ashley-en", "opus", "hello world")
    assert a == cache_key("tts", "ashley-en", "opus", "hello world")  # deterministic
    assert len(a) == 64 and all(c in "0123456789abcdef" for c in a)
    # a different voice or format is a different key
    assert cache_key("tts", "ashley-ja", "opus", "hello world") != a
    assert cache_key("tts", "ashley-en", "mp3", "hello world") != a
    # speed is not even an argument, so it can never enter the key (shared across speeds)
    assert "speed" not in inspect.signature(cache_key).parameters


def test_cache_key_separates_tts_endpoints() -> None:
    """Two engines serve different audio under the same voice id."""
    a = cache_key("tts", "ashley-en", "opus", "hello world", endpoint="http://a/v1")
    assert a == cache_key("tts", "ashley-en", "opus", "hello world", endpoint="http://a/v1")
    assert a != cache_key("tts", "ashley-en", "opus", "hello world", endpoint="http://b/v1")


def test_cache_key_without_endpoint_keeps_legacy_hash() -> None:
    key = cache_key("tts", "ashley-en", "opus", "hello world")
    assert key == hashlib.sha256(b"tts|ashley-en|opus|hello world").hexdigest()


def test_miss_synthesizes_then_hit_makes_no_http_call(db: Session, settings: Settings) -> None:
    client = _CountingClient()
    row, was_cached = get_or_synthesize(db, settings, client, "Once upon a time.", "ashley-en")
    assert was_cached is False and client.calls == 1
    assert Path(row.path).exists()
    assert row.bytes == len(client.data)
    assert row.duration_s == pytest.approx(1.0, abs=0.1)  # mutagen read the opus file

    again, cached = get_or_synthesize(db, settings, client, "Once upon a time.", "ashley-en")
    assert cached is True and client.calls == 1  # no second HTTP call
    assert again.cache_key == row.cache_key


def test_cache_is_shared_across_speeds_and_books(db: Session, settings: Settings) -> None:
    client = _CountingClient()
    r1, _ = get_or_synthesize(db, settings, client, "identical sentence", "ashley-en")
    r2, _ = get_or_synthesize(db, settings, client, "identical sentence", "ashley-en")
    assert r1.cache_key == r2.cache_key and r1.path == r2.path
    assert client.calls == 1  # one synth for the same text regardless of caller
    assert len(list((settings.data_dir / "audio").rglob(f"{r1.cache_key}.*"))) == 1


def test_normalize_before_keying_reuses_entries(db: Session, settings: Settings) -> None:
    client = _CountingClient()
    get_or_synthesize(db, settings, client, "See Dr. Who.", "ashley-en")
    # Same speech after normalization ("Doctor Who") hits the same key.
    _, cached = get_or_synthesize(db, settings, client, "See Doctor Who.", "ashley-en")
    assert cached is True and client.calls == 1


_LONG = " ".join(
    f"Sentence number {n} walks slowly along the harbour wall in the evening fog."
    for n in range(12)
)  # 12 sentences of 74-75 chars


def test_each_sentence_is_a_request_and_the_clip_knows_where_each_starts(
    db: Session, settings: Settings
) -> None:
    """Cloned voices degrade late in a long generation, so every sentence is
    its own request; the joined clip records where each sentence starts, which
    is what read-along follows."""
    client = _CountingClient()
    row, cached = get_or_synthesize(db, settings, client, _LONG, "tess", language="en")
    assert cached is False
    assert client.calls == 12  # one request per sentence
    assert " ".join(client.texts) == _LONG  # nothing dropped, order kept
    assert row.duration_s == pytest.approx(12.0, abs=0.3)  # twelve 1 s clips in one file
    assert row.marks is not None and len(row.marks) == 12
    assert row.marks[0] == [0.0, 0.0]
    fractions = [mark[0] for mark in row.marks]
    seconds = [mark[1] for mark in row.marks]
    assert fractions == sorted(fractions) and seconds == sorted(seconds)
    assert fractions[6] == pytest.approx(_LONG.index("Sentence number 6") / len(_LONG))
    # Each 1 s test clip decodes to ~1.02 s (encoder priming and padding stay
    # in the joined file), so sentence 7 starts just after 6 s, evenly spaced.
    assert 6.0 <= seconds[6] < 6.2
    assert seconds[6] == pytest.approx(6 * seconds[1], rel=0.01)
    assert row.cache_key == speech_cache_key(settings, "tess", _LONG, "", "en")
    assert row.text_key == single_request_key(settings, "tess", _LONG, "")


def test_a_single_sentence_keeps_its_old_key_and_needs_no_marks(
    db: Session, settings: Settings
) -> None:
    client = _CountingClient()
    row, _ = get_or_synthesize(db, settings, client, "Once upon a time.", "tess", language="en")
    assert row.marks is None
    endpoint = (settings.tts_base_url or "").rstrip("/")
    assert row.cache_key == cache_key(
        settings.tts_model, "tess", settings.tts_format, "Once upon a time.", endpoint=endpoint
    )


def test_split_segments_have_their_own_key(settings: Settings) -> None:
    endpoint = (settings.tts_base_url or "").rstrip("/")
    single = cache_key(settings.tts_model, "tess", settings.tts_format, _LONG, endpoint=endpoint)
    v014 = cache_key(
        settings.tts_model, "tess", settings.tts_format, _LONG, endpoint=endpoint, split="300"
    )
    key = speech_cache_key(settings, "tess", _LONG, "", "en")
    assert key not in (single, v014)
    whole = settings.model_copy(update={"tts_request_chars": 0})
    assert speech_cache_key(whole, "tess", _LONG, "", "en") == single


def test_mixed_formats_across_requests_fail_the_segment(db: Session, settings: Settings) -> None:
    from folio.tts import TtsError

    class _Flaky(_CountingClient):
        def synthesize(
            self, text: str, voice: str, instructions: str | None = None
        ) -> tuple[bytes, str]:
            data, _ = super().synthesize(text, voice, instructions)
            return data, "opus" if self.calls == 1 else "mp3"

    with pytest.raises(TtsError):
        get_or_synthesize(db, settings, _Flaky(), _LONG, "tess", language="en")


def test_duration_seconds_missing_file_is_zero(tmp_path: Path) -> None:
    assert duration_seconds(tmp_path / "nope.opus") == 0.0


def _mk_audio(
    db: Session,
    settings: Settings,
    *,
    text: str,
    created_at: datetime,
    last_played_at: datetime | None = None,
    nbytes: int = 1000,
) -> Audio:
    key = cache_key("tts", "ashley-en", "opus", text)
    path = cache_path(settings, key, "opus")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * nbytes)
    row = Audio(
        cache_key=key,
        path=str(path),
        format="opus",
        voice="ashley-en",
        model="tts",
        duration_s=1.0,
        bytes=nbytes,
        created_at=created_at,
        last_played_at=last_played_at,
    )
    db.add(row)
    db.flush()
    return row


def _segment(db: Session) -> Segment:
    book = Book(status="ready", language="en", title="B")
    db.add(book)
    db.flush()
    chapter = Chapter(book_id=book.id, idx=0, title="C", char_count=1)
    db.add(chapter)
    db.flush()
    segment = Segment(chapter_id=chapter.id, idx=0, text="t", char_start=0, char_end=1)
    db.add(segment)
    db.flush()
    return segment


def test_eviction_skips_recent_and_busy_files(db: Session, settings: Settings) -> None:
    now = datetime.now(UTC)
    old = now - timedelta(hours=1)
    recent = _mk_audio(db, settings, text="recent", created_at=now)
    busy = _mk_audio(db, settings, text="busy", created_at=old)
    stale = _mk_audio(db, settings, text="stale", created_at=old, last_played_at=old)
    db.add(
        SegmentAudio(
            segment_id=_segment(db).id, voice="ashley-en", cache_key=busy.cache_key, status="queued"
        )
    )
    db.commit()

    zero = Settings(_env_file=None, audio_cache_max_gb=0)  # type: ignore[call-arg]
    removed = evict_if_needed(db, zero)

    assert removed == 1  # only the stale, unplayed-in-a-while, not-busy file
    assert db.get(Audio, stale.cache_key) is None
    assert not Path(stale.path).exists()
    assert db.get(Audio, recent.cache_key) is not None  # within 10 minutes
    assert Path(recent.path).exists()
    assert db.get(Audio, busy.cache_key) is not None  # referenced by a queued segment
    assert Path(busy.path).exists()


def test_eviction_is_noop_under_the_limit(db: Session, settings: Settings) -> None:
    _mk_audio(db, settings, text="one", created_at=datetime.now(UTC) - timedelta(hours=1))
    assert evict_if_needed(db, settings) == 0  # default 50 GB, nothing to do


def _table_exists(dsn: str, name: str) -> bool:
    with psycopg.connect(dsn) as conn:
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name = %s", (name,)
        ).fetchone()
    return row is not None


def test_migration_0004_up_and_down(settings: Settings) -> None:
    url = make_url(settings.database_url)
    assert url.host and url.database
    mig_db = "folio_test_tts_migrations"
    dsn = (f"postgresql+psycopg://{url.username}:{url.password}@{url.host}:5432/{mig_db}").replace(
        "postgresql+psycopg", "postgresql", 1
    )
    maint = f"postgresql://{url.username}:{url.password}@{url.host}:5432/postgres"
    with psycopg.connect(maint, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{mig_db}"')
    env = dict(os.environ, DATABASE_URL=dsn, FOLIO_TEST_MODE="false")
    alembic = str(sys_path / ".venv" / "bin" / "alembic")
    try:
        subprocess.run(
            [alembic, "upgrade", "head"], cwd=sys_path, env=env, check=True, capture_output=True
        )
        assert _table_exists(dsn, "audio")
        assert _table_exists(dsn, "segment_audio")
        subprocess.run(
            [alembic, "downgrade", "0003"], cwd=sys_path, env=env, check=True, capture_output=True
        )
        assert not _table_exists(dsn, "audio")
        assert not _table_exists(dsn, "segment_audio")
    finally:
        with psycopg.connect(maint, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{mig_db}" WITH (FORCE)')
