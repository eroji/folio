"""Joining the clips of one segment's TTS requests into a single file."""

from __future__ import annotations

import io
import struct

import mutagen
import pytest
from mock_tts import SILENT_OPUS

from folio.tts import TtsError
from folio.tts.adts import adts_duration
from folio.tts.join import join_clips, ogg_crc

# --- AAC (ADTS) --------------------------------------------------------------


def _adts_frame(payload: bytes = b"\x00" * 20) -> bytes:
    length = 7 + len(payload)
    # sync, MPEG-4, no CRC; AAC-LC, 24 kHz (index 6), mono; one raw block
    header = bytes(
        [
            0xFF,
            0xF1,
            (1 << 6) | (6 << 2),
            (1 << 6) | ((length >> 11) & 0x03),
            (length >> 3) & 0xFF,
            ((length & 0x07) << 5) | 0x1F,
            0xFC,
        ]
    )
    return header + payload


def _id3(size: int = 10) -> bytes:
    return b"ID3\x04\x00\x00" + bytes([0, 0, 0, size]) + b"\x00" * size


def test_aac_parts_concatenate_frames_and_drop_id3() -> None:
    a = _id3() + _adts_frame() * 3
    b = _id3() + _adts_frame() * 5 + b"junk"
    joined = join_clips([a, b], "aac")
    assert not joined.startswith(b"ID3")
    assert b"ID3" not in joined and not joined.endswith(b"junk")
    assert adts_duration(joined) == pytest.approx(8 * 1024 / 24000)


# --- MP3 ---------------------------------------------------------------------

_MP3_HEADER = b"\xff\xfb\x90\xc0"  # MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono
_MP3_FRAME_LEN = 417


def _mp3_frame(tag: bytes = b"") -> bytes:
    body = bytearray(_MP3_FRAME_LEN - 4)
    body[17 : 17 + len(tag)] = tag  # Xing/Info sits after the side info
    return _MP3_HEADER + bytes(body)


def test_mp3_parts_drop_id3_tags_and_vbr_header_frames() -> None:
    a = _id3() + _mp3_frame(b"Info") + _mp3_frame() * 4 + b"TAG" + b"\x00" * 125
    b = _id3() + _mp3_frame(b"Xing") + _mp3_frame() * 6
    joined = join_clips([a, b], "mp3")
    assert len(joined) == 10 * _MP3_FRAME_LEN  # 4 + 6 audio frames, nothing else
    assert b"Xing" not in joined and b"Info" not in joined and b"TAG" not in joined
    length = mutagen.File(io.BytesIO(joined)).info.length  # type: ignore[union-attr]
    assert length == pytest.approx(10 * 1152 / 44100, rel=0.02)


# --- Ogg Opus ----------------------------------------------------------------


def _pages(data: bytes) -> list[dict[str, object]]:
    pages = []
    pos = 0
    while pos < len(data):
        assert data[pos : pos + 4] == b"OggS"
        htype, granule, serial, seq, crc, count = struct.unpack_from("<xBqIIIB", data, pos + 4)
        lacing = data[pos + 27 : pos + 27 + count]
        end = pos + 27 + count + sum(lacing)
        page = bytearray(data[pos:end])
        page[22:26] = b"\x00\x00\x00\x00"
        pages.append(
            {
                "htype": htype,
                "granule": granule,
                "serial": serial,
                "seq": seq,
                "crc_ok": ogg_crc(bytes(page)) == crc,
                "body": data[pos + 27 + count : end],
            }
        )
        pos = end
    return pages


def test_ogg_crc_matches_a_real_encoder() -> None:
    page = _pages(SILENT_OPUS)[0]
    assert page["crc_ok"]


def test_opus_parts_become_one_logical_stream() -> None:
    joined = join_clips([SILENT_OPUS, SILENT_OPUS, SILENT_OPUS], "opus")
    pages = _pages(joined)
    assert all(page["crc_ok"] for page in pages)
    assert {page["serial"] for page in pages} == {pages[0]["serial"]}
    assert [page["seq"] for page in pages] == list(range(len(pages)))
    assert [page["htype"] & 0x02 for page in pages].count(0x02) == 1  # BOS once, first
    assert pages[0]["htype"] & 0x02
    assert [page["htype"] & 0x04 for page in pages].count(0x04) == 1  # EOS once, last
    assert pages[-1]["htype"] & 0x04
    assert joined.count(b"OpusHead") == 1 and joined.count(b"OpusTags") == 1
    granules = [page["granule"] for page in pages[2:] if page["granule"] != -1]
    assert granules == sorted(granules)
    # Three 1 s clips: about 3 s, plus the later clips' few-ms encoder priming.
    length = mutagen.File(io.BytesIO(joined)).info.length  # type: ignore[union-attr]
    assert 3.0 <= length < 3.05


def test_a_single_part_is_returned_untouched() -> None:
    assert join_clips([SILENT_OPUS], "opus") is SILENT_OPUS
    assert join_clips([b"anything"], "wav") == b"anything"


def test_unreadable_or_unknown_audio_fails_the_segment() -> None:
    with pytest.raises(TtsError):
        join_clips([SILENT_OPUS, b"not ogg"], "opus")
    with pytest.raises(TtsError):
        join_clips([b"a", b"b"], "wav")
