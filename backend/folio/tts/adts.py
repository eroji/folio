"""Exact duration of an AAC clip in ADTS framing.

mutagen only estimates ADTS length from the bitrate. HLS needs the real
length: each segment's EXTINF and its ID3 timestamp are sums of the clips
before it, and an estimate would drift the stream's timeline.
"""

from __future__ import annotations

# ADTS sampling_frequency_index -> Hz (ISO/IEC 14496-3).
_RATES = (96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)
_SAMPLES_PER_BLOCK = 1024


def id3_size(data: bytes) -> int:
    if len(data) >= 10 and data[:3] == b"ID3":
        size = data[6] << 21 | data[7] << 14 | data[8] << 7 | data[9]  # syncsafe
        return 10 + size + (10 if data[5] & 0x10 else 0)  # footer flag
    return 0


def adts_duration(data: bytes) -> float:
    """Seconds of audio in ``data``: frames x raw blocks x 1024 samples / rate.

    Stops at the first byte run that is not a valid ADTS header (trailing
    padding or garbage), so the sum only ever counts whole frames.
    """
    pos = id3_size(data)
    samples = 0
    rate = 0
    while pos + 7 <= len(data):
        if data[pos] != 0xFF or data[pos + 1] & 0xF6 != 0xF0:
            break
        index = (data[pos + 2] >> 2) & 0x0F
        length = (data[pos + 3] & 0x03) << 11 | data[pos + 4] << 3 | data[pos + 5] >> 5
        if index >= len(_RATES) or length < 7 or pos + length > len(data):
            break
        rate = _RATES[index]
        samples += ((data[pos + 6] & 0x03) + 1) * _SAMPLES_PER_BLOCK
        pos += length
    return samples / rate if rate else 0.0
