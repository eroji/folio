"""ffmpeg encoding of an engine's raw PCM into the clip format.

fish-s2-openai streams only raw PCM (mono s16le at its ``X-Sample-Rate``), and
only a streamed request stops when the client hangs up. Folio therefore asks
for PCM and encodes it here, matching the engine's own encode (mono 44.1 kHz,
128 kb/s) so clips made either way stay one format in an iPhone's HLS stream.
"""

from __future__ import annotations

import shutil
import subprocess

# ffmpeg codec and container for each clip format it can produce here, and
# the media type a stream of it is served as.
ENCODE: dict[str, tuple[list[str], str]] = {
    "aac": (["-c:a", "aac", "-f", "adts"], "audio/aac"),
    "mp3": (["-c:a", "libmp3lame", "-f", "mp3"], "audio/mpeg"),
}
_OUTPUT = ["-ar", "44100", "-ac", "1", "-b:a", "128k"]
# fish-s2-openai's PCM_SAMPLE_RATE default, for an engine that sends no header.
DEFAULT_PCM_RATE = 24000


def can_encode(fmt: str) -> bool:
    """This clip format can be made from PCM here (and ffmpeg is installed)."""
    return fmt in ENCODE and shutil.which("ffmpeg") is not None


def ffmpeg_args(rate: int, fmt: str, *, live: bool) -> list[str]:
    """ffmpeg reading mono s16le PCM at ``rate`` on stdin, writing ``fmt`` on
    stdout; ``live`` writes each packet as soon as it is encoded."""
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if live:
        # No read-ahead: by default ffmpeg probes ~5 s of input before it
        # writes a byte, and a listener hears nothing until then.
        args += ["-probesize", "32", "-analyzeduration", "0", "-fflags", "nobuffer"]
    args += ["-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0", *_OUTPUT, *ENCODE[fmt][0]]
    if live:
        args += ["-flush_packets", "1"]
    return [*args, "pipe:1"]


def encode_pcm(pcm: bytes, rate: int, fmt: str) -> bytes:
    """Encode a whole PCM clip to ``fmt``."""
    return subprocess.run(
        ffmpeg_args(rate, fmt, live=False),
        input=pcm[: len(pcm) // 2 * 2],
        capture_output=True,
        check=True,
    ).stdout
