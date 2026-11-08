"""HLS book stream for iOS: ADTS durations, the ID3 timestamp, and the
playlist / segment / timeline endpoints (Safari plays one continuous track,
so no page JavaScript has to run at clip boundaries on a locked screen)."""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.models import Audio, Book, Chapter, Segment, SegmentAudio
from folio.tts.adts import adts_duration
from folio.tts.cache import duration_seconds
from folio.tts.queue import PRIORITY_NOW
from folio.tts.stream import hls_timestamp_tag

VOICE = "ashley-en"
RATE = 48000


def adts(frames: int, rate_index: int = 3, payload: int = 20) -> bytes:
    """``frames`` minimal AAC-LC ADTS frames (48 kHz mono at index 3)."""
    length = 7 + payload
    header = bytes(
        [
            0xFF,
            0xF1,  # MPEG-4, layer 0, no CRC
            (1 << 6) | (rate_index << 2) | 0,  # LC profile, sample-rate index, mono (hi bit)
            (1 << 6) | (length >> 11),  # mono (lo bits), frame length bits 12-11
            (length >> 3) & 0xFF,
            ((length & 0x7) << 5) | 0x1F,
            0xFC,  # buffer fullness, one raw data block
        ]
    )
    return (header + bytes(payload)) * frames


def seconds(frames: int) -> float:
    return frames * 1024 / RATE


# --- ADTS + ID3 -------------------------------------------------------------------------


def test_adts_duration_counts_frames_exactly(tmp_path) -> None:
    path = tmp_path / "clip.aac"
    path.write_bytes(adts(47))
    assert adts_duration(path.read_bytes()) == pytest.approx(seconds(47), abs=1e-9)
    assert duration_seconds(path) == pytest.approx(seconds(47), abs=1e-9)  # the cache uses it


def test_adts_duration_skips_a_leading_id3_tag_and_stops_at_garbage() -> None:
    data = hls_timestamp_tag(3.0) + adts(10) + b"\x00garbage"
    assert adts_duration(data) == pytest.approx(seconds(10), abs=1e-9)


def test_hls_timestamp_tag_is_the_apple_packed_audio_priv_frame() -> None:
    tag = hls_timestamp_tag(1.5)
    assert tag[:5] == b"ID3\x04\x00"
    assert b"PRIV" in tag
    assert b"com.apple.streaming.transportStreamTimestamp\x00" in tag
    assert int.from_bytes(tag[-8:], "big") == 135_000  # 1.5 s at 90 kHz
    size = tag[6] << 21 | tag[7] << 14 | tag[8] << 7 | tag[9]  # syncsafe
    assert size == len(tag) - 10


# --- Endpoints ----------------------------------------------------------------------------


def _book(
    db: Session, chapters: tuple[int, ...] = (3, 2), excluded: int | None = None
) -> tuple[Book, list[Segment]]:
    book = Book(title="Streamed", language="en", status="ready")
    db.add(book)
    db.flush()
    ordered: list[Segment] = []
    for c, count in enumerate(chapters):
        chapter = Chapter(
            book_id=book.id, idx=c, title=f"Ch {c}", char_count=count * 10, excluded=c == excluded
        )
        db.add(chapter)
        db.flush()
        for i in range(count):
            segment = Segment(
                chapter_id=chapter.id,
                idx=i,
                text=f"Line {c}.{i} {uuid.uuid4().hex}.",
                char_start=i * 10,
                char_end=(i + 1) * 10,
            )
            db.add(segment)
            if c != excluded:
                ordered.append(segment)
    db.commit()
    return book, ordered


def _ready(
    db: Session, settings: Settings, segment: Segment, frames: int, fmt: str = "aac"
) -> bytes:
    key = uuid.uuid4().hex * 2
    path = settings.data_dir / "audio" / key[:2] / f"{key}.{fmt}"
    path.parent.mkdir(parents=True, exist_ok=True)
    data = adts(frames)
    path.write_bytes(data)
    db.add(
        Audio(
            cache_key=key,
            path=str(path),
            format=fmt,
            voice=VOICE,
            model="tts",
            duration_s=seconds(frames),
            bytes=len(data),
        )
    )
    db.add(SegmentAudio(segment_id=segment.id, voice=VOICE, cache_key=key, status="ready"))
    db.commit()
    return data


def _playlist_url(book: Book, start: Segment) -> str:
    return f"/api/v1/books/{book.id}/stream.m3u8?voice={VOICE}&from={start.id}"


async def test_playlist_lists_the_ready_run_with_exact_durations_and_queues_the_gap(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    settings = get_settings()
    book, segs = _book(db)
    _ready(db, settings, segs[0], 47)
    _ready(db, settings, segs[1], 40)
    # segs[2] is not generated yet; segs[3] is, but must not be listed past the gap.
    _ready(db, settings, segs[3], 30)

    response = await auth_client.get(_playlist_url(book, segs[0]))

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/vnd.apple.mpegurl")
    assert "no-store" in response.headers["cache-control"]
    body = response.text
    assert body.startswith("#EXTM3U\n")
    assert "#EXT-X-PLAYLIST-TYPE:EVENT" in body
    assert "#EXT-X-ENDLIST" not in body  # still growing
    assert f"#EXTINF:{seconds(47):.6f}," in body and f"#EXTINF:{seconds(40):.6f}," in body
    assert body.count("#EXTINF") == 2
    assert f"stream/0.aac?voice={VOICE}&from={segs[0].id}" in body
    assert "#EXT-X-TARGETDURATION:60" in body
    # The first missing segment is queued as needed-now, so generation keeps going
    # while the phone's JavaScript is frozen and only the media player polls.
    db.expire_all()
    row = db.scalar(select(SegmentAudio).where(SegmentAudio.segment_id == segs[2].id))
    assert row is not None and row.priority == PRIORITY_NOW


async def test_playlist_crosses_chapters_skips_excluded_ones_and_ends(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    settings = get_settings()
    book, segs = _book(db, chapters=(2, 2, 1), excluded=1)
    for s in segs:
        _ready(db, settings, s, 20)
    body = (await auth_client.get(_playlist_url(book, segs[0]))).text
    assert body.count("#EXTINF") == 3  # 2 + the 1 in chapter 2; chapter 1 is excluded
    assert body.rstrip().endswith("#EXT-X-ENDLIST")


async def test_segment_carries_its_timeline_position_and_the_clip(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    settings = get_settings()
    book, segs = _book(db)
    _ready(db, settings, segs[0], 47)
    _ready(db, settings, segs[1], 40)
    clip = _ready(db, settings, segs[2], 33)
    # The playlist starts at segs[1]: segment 1 of the stream is segs[2].
    url = f"/api/v1/books/{book.id}/stream/1.aac?voice={VOICE}&from={segs[1].id}"

    response = await auth_client.get(url)

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/aac"
    tag = hls_timestamp_tag(seconds(40))  # starts after segs[1]
    assert response.content == tag + clip
    missing = await auth_client.get(
        f"/api/v1/books/{book.id}/stream/9.aac?voice={VOICE}&from={segs[1].id}"
    )
    assert missing.status_code == 404


async def test_timeline_maps_stream_time_to_segments(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    settings = get_settings()
    book, segs = _book(db, chapters=(1, 1))
    _ready(db, settings, segs[0], 47)
    _ready(db, settings, segs[1], 40)
    response = await auth_client.get(
        f"/api/v1/books/{book.id}/stream.json?voice={VOICE}&from={segs[0].id}"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["complete"] is True
    assert body["voice"] == VOICE
    assert [e["segment_id"] for e in body["entries"]] == [str(segs[0].id), str(segs[1].id)]
    assert body["entries"][1]["chapter_id"] == str(segs[1].chapter_id)
    assert body["entries"][1]["start"] == pytest.approx(seconds(47))
    assert body["entries"][1]["duration"] == pytest.approx(seconds(40))


async def test_a_clip_in_another_format_ends_the_stream(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    """Opus clips cached before the switch to AAC cannot be HLS segments."""
    settings = get_settings()
    book, segs = _book(db, chapters=(2,))
    _ready(db, settings, segs[0], 20)
    _ready(db, settings, segs[1], 20, fmt="opus")
    body = (await auth_client.get(_playlist_url(book, segs[0]))).text
    assert body.count("#EXTINF") == 1
    assert "#EXT-X-ENDLIST" not in body


async def test_stream_needs_a_session_and_a_known_segment(
    client: httpx.AsyncClient, auth_client: httpx.AsyncClient, db: Session
) -> None:
    book, segs = _book(db)
    unknown = await auth_client.get(
        f"/api/v1/books/{book.id}/stream.m3u8?voice={VOICE}&from={uuid.uuid4()}"
    )
    assert unknown.status_code == 404
    client.cookies.clear()
    assert (await client.get(_playlist_url(book, segs[0]))).status_code == 401


@pytest.mark.parametrize(("fmt", "expected"), [("aac", True), ("opus", False)])
async def test_prepare_says_whether_the_book_can_stream(
    auth_client: httpx.AsyncClient, db: Session, fmt: str, expected: bool
) -> None:
    app = auth_client._transport.app  # type: ignore[attr-defined]
    settings = get_settings().model_copy(update={"tts_format": fmt})
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        book, segs = _book(db, chapters=(1,))
        response = await auth_client.post(
            f"/api/v1/books/{book.id}/audio/prepare",
            json={"segment_id": str(segs[0].id), "count": 0, "voice": VOICE},
            headers={"X-CSRF-Token": auth_client.cookies.get("folio_csrf", "")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["stream"] is expected
    finally:
        app.dependency_overrides.pop(get_settings, None)


async def test_a_failed_top_up_never_fails_the_playlist(
    auth_client: httpx.AsyncClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Queueing is a side effect: the media player must still get its playlist."""
    from sqlalchemy.exc import IntegrityError

    from folio.tts import stream as stream_module

    def boom(*_args: object, **_kw: object) -> None:
        raise IntegrityError("INSERT", {}, Exception("duplicate key"))

    monkeypatch.setattr(stream_module, "prepare", boom)
    settings = get_settings()
    book, segs = _book(db, chapters=(2,))
    _ready(db, settings, segs[0], 20)
    response = await auth_client.get(_playlist_url(book, segs[0]))
    assert response.status_code == 200
    assert response.text.count("#EXTINF") == 1
