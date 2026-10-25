"""Text preparation for speech (spec: TTS → Text preparation for speech).

Applied to a segment right before it is sent to the engine, and when computing
the cache key, so the same source text always hashes the same way.
"""

from __future__ import annotations

import re

# Honorifics expand only when a capitalized name follows ("Dr. Who" -> "Doctor
# Who", but a bare "the Dr." is left alone).
_HONORIFICS = {
    "Dr": "Doctor",
    "Mr": "Mister",
    "Mrs": "Mistress",
    "Ms": "Miss",
    "Prof": "Professor",
}
_HONORIFIC_RE = re.compile(r"\b(Dr|Mr|Mrs|Ms|Prof)\.(?=\s+[A-Z])")

# Latin abbreviations expand wherever they stand as their own token.
_ABBREVS = (("e.g.", "for example"), ("i.e.", "that is"))

# Bracketed footnote markers ("as shown[12]") carry no sound.
_FOOTNOTE_RE = re.compile(r"\s*\[\d+\]")

# http(s) URLs become the word "link".
_URL_RE = re.compile(r"https?://\S+")


def _expand_honorific(match: re.Match[str]) -> str:
    return _HONORIFICS[match.group(1)]


def normalize_speech_text(text: str) -> str:
    """Make ``text`` speakable: drop noise, expand safe abbreviations, tidy spaces.

    Never returns an empty string for non-empty input.
    """
    if not text.strip():
        return ""
    out = _URL_RE.sub(" link ", text)
    out = _FOOTNOTE_RE.sub("", out)
    out = _HONORIFIC_RE.sub(_expand_honorific, out)
    for abbrev, expansion in _ABBREVS:
        out = out.replace(abbrev, expansion)
    out = re.sub(r"\s+", " ", out).strip()
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)  # tidy gaps left by dropped markers
    # A segment that was only a footnote marker or whitespace must still speak.
    return out if out else text.strip()


# The plan names both spellings for the same preparation step.
prepare_for_speech = normalize_speech_text
