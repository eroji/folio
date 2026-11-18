"""Sentence segmentation and TTS-length segment packing (spec ingestion step 6).

Chapters arrive already cleaned (``folio.ingest.clean``); every emitted
sentence/segment is an exact substring of the chapter text, so
``text[char_start:char_end] == piece.text`` always holds and progress can be
reported as a character percentage.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache
from typing import Any

import pysbd  # type: ignore[import-untyped]
from pysbd.languages import LANGUAGE_CODES  # type: ignore[import-untyped]

# Split points for a sentence that alone exceeds max_chars, in order:
# clause punctuation, then whitespace, then a hard slice (spec step 6).
_SPLIT_LEVELS = (re.compile(r"[,;:—]\s*"), re.compile(r"\s+"))


@dataclass
class SegmentedSentence:
    text: str
    char_start: int
    char_end: int


@dataclass
class SegmentedChapter:
    title: str
    text: str
    sentences: list[SegmentedSentence]
    segments: list[SegmentedSentence]


def _base_language(language: str) -> str:
    base = language.split("-")[0].lower()
    return base if base in LANGUAGE_CODES else "en"


@cache
def _segmenter(base: str) -> Any:
    # pysbd.Segmenter keeps per-call state; ingest runs one job at a time,
    # so sharing cached segmenters across calls is safe.
    return pysbd.Segmenter(language=base, clean=False)


def split_sentences(text: str, language: str) -> list[str]:
    """Split text into sentences with pysbd; whitespace-only pieces are dropped."""
    return [s for s in _segmenter(_base_language(language)).segment(text) if s.strip()]


def _locate(text: str, sentences: list[str]) -> list[SegmentedSentence]:
    """Attach offsets by walking the exact substrings pysbd returned."""
    located: list[SegmentedSentence] = []
    cursor = 0
    for sentence in sentences:
        idx = text.find(sentence, cursor)
        if idx < 0:  # defensive: pysbd with clean=False returns substrings
            continue
        located.append(SegmentedSentence(sentence, idx, idx + len(sentence)))
        cursor = idx + len(sentence)
    return located


def _split_span(
    text: str, start: int, end: int, limit: int, level: int = 0
) -> list[SegmentedSentence]:
    """Split [start, end) into non-empty pieces of at most ``limit`` chars."""
    if end - start <= limit:
        piece = text[start:end]
        return [SegmentedSentence(piece, start, end)] if piece.strip() else []
    if level < len(_SPLIT_LEVELS):
        cuts = [m.end() for m in _SPLIT_LEVELS[level].finditer(text, start, end) if m.end() < end]
        if not cuts:
            return _split_span(text, start, end, limit, level + 1)
        pieces: list[SegmentedSentence] = []
        group_start = fragment_end = start
        for bound in cuts + [end]:
            if bound - group_start > limit and fragment_end > group_start:
                pieces += _split_span(text, group_start, fragment_end, limit, level + 1)
                group_start = fragment_end
            fragment_end = bound
        pieces += _split_span(text, group_start, fragment_end, limit, level + 1)
        return pieces
    return [
        SegmentedSentence(text[i : min(i + limit, end)], i, min(i + limit, end))
        for i in range(start, end, limit)
        if text[i : min(i + limit, end)].strip()
    ]


def _pack(text: str, sentences: list[SegmentedSentence], max_chars: int) -> list[SegmentedSentence]:
    """Pack sentences greedily into pieces of at most ``max_chars``; a sentence
    is only split (at clauses, then words) when it alone exceeds the limit."""
    segments: list[SegmentedSentence] = []
    group_open = False
    group_start = group_end = 0
    for sentence in sentences:
        if group_open and sentence.char_end - group_start <= max_chars:
            group_end = sentence.char_end
            continue
        if group_open:
            segments += _split_span(text, group_start, group_end, max_chars)
        group_start, group_end, group_open = sentence.char_start, sentence.char_end, True
    if group_open:
        segments += _split_span(text, group_start, group_end, max_chars)
    return segments


def segment_chapter(chapter: Any, language: str, max_chars: int = 800) -> SegmentedChapter:
    """Segment a cleaned chapter (duck-typed ``.title``/``.text``) into
    sentences and TTS-length segments of at most ``max_chars``."""
    text = chapter.text
    sentences = _locate(text, split_sentences(text, language))
    segments = _pack(text, sentences, max_chars)
    return SegmentedChapter(title=chapter.title, text=text, sentences=sentences, segments=segments)


def split_for_speech(text: str, language: str, max_chars: int) -> list[str]:
    """One segment's text as the pieces sent to the engine, one request each
    (``TTS_REQUEST_CHARS``): whole sentences packed up to ``max_chars``.
    ``max_chars`` 0, or a text that already fits, is a single piece."""
    if max_chars <= 0 or len(text) <= max_chars:
        return [text]
    pieces = _pack(text, _locate(text, split_sentences(text, language)), max_chars)
    return [piece.text.strip() for piece in pieces if piece.text.strip()] or [text]
