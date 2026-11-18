"""Join the clips of one segment's TTS requests into a single file.

A segment longer than ``TTS_REQUEST_CHARS`` is synthesized as several requests
(see ``cache.get_or_synthesize``); the player, the HLS stream and the cache
still deal in one file per segment. No ffmpeg in the image, so each format is
joined by hand:

- AAC (ADTS) and MP3 are self-framed: drop the tags and VBR header frames,
  concatenate the audio frames.
- Ogg Opus is re-muxed into one logical stream: the first clip's OpusHead and
  OpusTags, then every clip's audio packets on fresh pages (one serial, page
  numbers, granule positions and CRCs recomputed). The later clips' encoder
  priming (a few ms each) stays in, as it would in any concatenation.
"""

from __future__ import annotations

import struct

from folio.tts import TtsError
from folio.tts.adts import adts_duration, id3_size

# --- AAC (ADTS) --------------------------------------------------------------


def _adts_frames(data: bytes) -> bytes:
    """The run of whole ADTS frames after any leading ID3 tag."""
    start = pos = id3_size(data)
    while pos + 7 <= len(data):
        if data[pos] != 0xFF or data[pos + 1] & 0xF6 != 0xF0:
            break
        length = (data[pos + 3] & 0x03) << 11 | data[pos + 4] << 3 | data[pos + 5] >> 5
        if length < 7 or pos + length > len(data):
            break
        pos += length
    if pos == start:
        raise TtsError("The TTS engine returned unreadable AAC audio.", code="tts_bad_audio")
    return data[start:pos]


# --- MP3 ---------------------------------------------------------------------

_MP3_KBPS = {
    1: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),  # MPEG-1 Layer III
    2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),  # MPEG-2/2.5 Layer III
}
_MP3_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
_VBR_TAGS = (b"Xing", b"Info", b"VBRI")


def _mp3_frame_length(header: bytes) -> int:
    """Length of the Layer III frame starting with ``header``; 0 if it isn't one."""
    if header[0] != 0xFF or header[1] & 0xE0 != 0xE0:
        return 0
    version = (header[1] >> 3) & 0x03  # 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    layer = (header[1] >> 1) & 0x03  # 1 = Layer III
    bitrate_index, rate_index = header[2] >> 4, (header[2] >> 2) & 0x03
    if version == 1 or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return 0
    kbps = _MP3_KBPS[1 if version == 3 else 2][bitrate_index]
    rate = _MP3_RATES[version][rate_index]
    padding = (header[2] >> 1) & 0x01
    return (144 if version == 3 else 72) * kbps * 1000 // rate + padding


def _mp3_seconds(header: bytes) -> float:
    """Seconds of audio in one Layer III frame."""
    version = (header[1] >> 3) & 0x03
    rate = _MP3_RATES[version][(header[2] >> 2) & 0x03]
    return (1152 if version == 3 else 576) / rate


def _mp3_frames(data: bytes) -> bytes:
    """Audio frames only: no ID3v2/ID3v1 tags, no Xing/Info/VBRI header frame
    (its frame count would describe one clip, not the joined file)."""
    end = len(data) - 128 if data[-128:-125] == b"TAG" else len(data)
    pos = id3_size(data)
    frames: list[bytes] = []
    while pos + 4 <= end:
        length = _mp3_frame_length(data[pos : pos + 4])
        if not length or pos + length > end:
            break
        frame = data[pos : pos + length]
        if frames or not any(tag in frame[4:48] for tag in _VBR_TAGS):
            frames.append(frame)
        pos += length
    if not frames:
        raise TtsError("The TTS engine returned unreadable MP3 audio.", code="tts_bad_audio")
    return b"".join(frames)


def _mp3_frame_count(frames: bytes) -> int:
    count = pos = 0
    while pos + 4 <= len(frames):
        length = _mp3_frame_length(frames[pos : pos + 4])
        if not length:
            break
        count += 1
        pos += length
    return count


# --- Ogg Opus ----------------------------------------------------------------


def _crc_table() -> list[int]:
    table = []
    for i in range(256):
        crc = i << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) if crc & 0x80000000 else crc << 1
        table.append(crc & 0xFFFFFFFF)
    return table


_CRC_TABLE = _crc_table()


def ogg_crc(page: bytes) -> int:
    """Ogg's page checksum (CRC-32, polynomial 0x04C11DB7, no reflection),
    computed with the checksum field zeroed."""
    crc = 0
    for byte in page:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC_TABLE[(crc >> 24) ^ byte]
    return crc


def _ogg_packets(data: bytes) -> tuple[list[bytes], int]:
    """All packets of a single-stream Ogg file, and its final granule position."""
    packets: list[bytes] = []
    partial = bytearray()
    final_granule = 0
    pos = 0
    while pos < len(data):
        if data[pos : pos + 4] != b"OggS" or pos + 27 > len(data):
            raise TtsError("The TTS engine returned unreadable Opus audio.", code="tts_bad_audio")
        granule = struct.unpack_from("<q", data, pos + 6)[0]
        count = data[pos + 26]
        lacing = data[pos + 27 : pos + 27 + count]
        body = pos + 27 + count
        if body + sum(lacing) > len(data):
            raise TtsError("The TTS engine returned truncated Opus audio.", code="tts_bad_audio")
        for size in lacing:
            partial += data[body : body + size]
            body += size
            if size < 255:
                packets.append(bytes(partial))
                partial.clear()
        if granule != -1:
            final_granule = granule
        pos = body
    if len(packets) < 2 or not packets[0].startswith(b"OpusHead"):
        raise TtsError("The TTS engine returned unreadable Opus audio.", code="tts_bad_audio")
    return packets, final_granule


def _opus_samples(packet: bytes) -> int:
    """48 kHz samples one Opus packet decodes to (RFC 6716, TOC byte)."""
    if not packet:
        return 0
    config = packet[0] >> 3
    if config < 12:  # SILK
        size = (480, 960, 1920, 2880)[config % 4]
    elif config < 16:  # hybrid
        size = (480, 960)[config % 2]
    else:  # CELT
        size = (120, 240, 480, 960)[config % 4]
    code = packet[0] & 0x03
    frames = 1 if code == 0 else 2 if code < 3 else (packet[1] & 0x3F if len(packet) > 1 else 0)
    return size * frames


class _OggWriter:
    """Writes packets onto pages of one logical stream."""

    _TARGET_BODY = 4096

    def __init__(self, serial: int) -> None:
        self.serial = serial
        self.seq = 0
        self.out = bytearray()
        self._lacing: list[int] = []
        self._body = bytearray()
        self._granule = -1
        self._continued = False

    def add(self, packet: bytes, granule: int, may_flush: bool = True) -> None:
        sizes = [255] * (len(packet) // 255) + [len(packet) % 255]
        offset = 0
        for index, size in enumerate(sizes):
            if len(self._lacing) == 255:
                self._flush(continued_next=True)
            self._lacing.append(size)
            self._body += packet[offset : offset + size]
            offset += size
            if index == len(sizes) - 1:
                self._granule = granule
        if may_flush and len(self._body) >= self._TARGET_BODY:
            self.flush()

    def flush(self, eos: bool = False) -> None:
        if self._lacing:
            self._flush(continued_next=False, eos=eos)

    def _flush(self, continued_next: bool, eos: bool = False) -> None:
        flags = (
            (0x01 if self._continued else 0) | (0x02 if self.seq == 0 else 0) | (0x04 if eos else 0)
        )
        page = bytearray(
            struct.pack(
                "<4sBBqIIIB",
                b"OggS",
                0,
                flags,
                self._granule,
                self.serial,
                self.seq,
                0,
                len(self._lacing),
            )
        )
        page += bytes(self._lacing) + self._body
        page[22:26] = struct.pack("<I", ogg_crc(bytes(page)))
        self.out += page
        self.seq += 1
        self._lacing, self._body, self._granule = [], bytearray(), -1
        self._continued = continued_next


def _join_opus(parts: list[bytes]) -> tuple[bytes, list[float]]:
    parsed = [_ogg_packets(part) for part in parts]
    preskip = struct.unpack_from("<H", parsed[0][0][0], 10)[0]
    head, tags = parsed[0][0][0], parsed[0][0][1]
    writer = _OggWriter(serial=struct.unpack_from("<I", parts[0], 14)[0])
    writer.add(head, 0)
    writer.flush()  # OpusHead alone on the first page, OpusTags ends its own page
    writer.add(tags, 0)
    writer.flush()
    audio = [packet for packets, _ in parsed for packet in packets[2:]]
    if not audio:
        raise TtsError("The TTS engine returned empty Opus audio.", code="tts_bad_audio")
    # Only the very end may be trimmed (RFC 7845): keep the last clip's own
    # end trim; the earlier clips' trimmed tails play as a few ms of padding.
    decoded_last = sum(_opus_samples(packet) for packet in parsed[-1][0][2:])
    trim = max(0, decoded_last - parsed[-1][1])
    total = 0
    starts: list[float] = []
    for packets, _ in parsed:
        # Playback time = decoded samples minus the first clip's pre-skip.
        starts.append(max(0, total - preskip) / 48000)
        total += sum(_opus_samples(packet) for packet in packets[2:])
    total = 0
    for index, packet in enumerate(audio):
        total += _opus_samples(packet)
        last = index == len(audio) - 1
        writer.add(packet, max(0, total - trim) if last else total, may_flush=not last)
    writer.flush(eos=True)  # the last page always carries the final packet
    return bytes(writer.out), starts


def _starts(durations: list[float]) -> list[float]:
    starts, at = [], 0.0
    for duration in durations:
        starts.append(at)
        at += duration
    return starts


def join_clips(parts: list[bytes], fmt: str) -> tuple[bytes, list[float]]:
    """One playable file from the clips of consecutive requests, in order, and
    the second each clip starts at in it (what read-along follows)."""
    if len(parts) == 1:
        return parts[0], [0.0]
    if fmt == "aac":
        frames = [_adts_frames(part) for part in parts]
        return b"".join(frames), _starts([adts_duration(f) for f in frames])
    if fmt == "mp3":
        frames = [_mp3_frames(part) for part in parts]
        seconds = [_mp3_seconds(f[:4]) * _mp3_frame_count(f) for f in frames]
        return b"".join(frames), _starts(seconds)
    if fmt == "opus":
        return _join_opus(parts)
    raise TtsError(f"Can't join {fmt} clips from the TTS engine.", code="tts_bad_audio")
