"""Sentence segmentation and greedy segment packing (spec pipeline step 6)."""

from dataclasses import dataclass

from folio.ingest.segment import (
    SegmentedChapter,
    segment_chapter,
    split_for_speech,
    split_sentences,
)


@dataclass
class Chapter:
    """Stand-in for T5a's ExtractedChapter (duck-typed on .title/.text)."""

    title: str
    text: str


def _chapter(text: str) -> Chapter:
    return Chapter(title="Chapter 1", text=text)


def test_split_sentences_english() -> None:
    sentences = split_sentences("Mr. Smith went to Washington. He bought an apple.", "en")
    assert [s.strip() for s in sentences] == [
        "Mr. Smith went to Washington.",
        "He bought an apple.",
    ]


def test_split_sentences_japanese_on_kuten() -> None:
    sentences = split_sentences("今日はいい天気です。明日は雨かもしれません。", "ja-JP")
    assert [s.strip() for s in sentences] == ["今日はいい天気です。", "明日は雨かもしれません。"]


def test_unknown_language_falls_back_to_english() -> None:
    assert len(split_sentences("Hello there. Fine.", "xx-YY")) == 2


def test_short_sentences_pack_greedily_under_the_limit() -> None:
    text = " ".join(f"Sentence number {i} is quite short." for i in range(30))
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    assert len(chapter.sentences) == 30
    assert len(chapter.segments) < len(chapter.sentences)
    assert all(0 < len(s.text) <= 800 for s in chapter.segments)
    # Nothing is lost or duplicated: segment texts reassemble the sentence texts.
    assert " ".join(" ".join(s.text.split()) for s in chapter.segments) == " ".join(
        " ".join(s.text.split()) for s in chapter.sentences
    )


def test_whole_sentences_are_never_split_when_they_fit() -> None:
    text = "One is short. Two is also short. Three fits too."
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    assert len(chapter.segments) == 1


def test_oversize_sentence_splits_on_commas_under_the_limit() -> None:
    text = ", ".join(f"clause {i:03d} of a very long run-on sentence" for i in range(80)) + "."
    assert len(text) > 2000
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    assert len(chapter.sentences) == 1
    assert all(0 < len(s.text) <= 800 for s in chapter.segments)


def test_oversize_sentence_without_commas_splits_on_spaces() -> None:
    text = "supercalifragilistic " * 120 + "."
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    assert all(0 < len(s.text) <= 800 for s in chapter.segments)


def test_oversize_unbreakable_run_is_hard_sliced() -> None:
    text = "x" * 2000
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    assert [len(s.text) for s in chapter.segments] == [800, 800, 400]


def test_offsets_reconstruct_exact_substrings() -> None:
    text = (
        "First sentence here. Second one follows.\n\nNew paragraph, with a comma. "
        + "z" * 1500
        + ". Last."
    )
    chapter = segment_chapter(_chapter(text), "en", max_chars=800)
    for piece in chapter.sentences + chapter.segments:
        assert text[piece.char_start : piece.char_end] == piece.text
    assert all(b.char_start >= a.char_end for a, b in zip(chapter.segments, chapter.segments[1:]))


def test_empty_chapter_yields_zero_segments() -> None:
    chapter = segment_chapter(_chapter(""), "en")
    assert isinstance(chapter, SegmentedChapter)
    assert chapter.title == "Chapter 1"
    assert chapter.sentences == []
    assert chapter.segments == []


def test_default_max_chars_is_800() -> None:
    chapter = segment_chapter(_chapter("word, " * 500), "en")
    assert all(len(s.text) <= 800 for s in chapter.segments)


# --- split_for_speech: one segment -> TTS request pieces ---------------------

_SENTENCE = "The harbour light swept twice across the water before the fog closed again. "


def test_split_for_speech_packs_whole_sentences_up_to_the_limit() -> None:
    text = (_SENTENCE * 8).strip()  # 8 x 76 chars
    pieces = split_for_speech(text, "en", 300)
    assert len(pieces) == 3  # 3 + 3 + 2 sentences
    assert all(len(piece) <= 300 for piece in pieces)
    assert all(piece.endswith("again.") for piece in pieces)  # never mid-sentence
    assert " ".join(pieces) == text


def test_split_for_speech_keeps_a_short_segment_whole() -> None:
    text = "One sentence. And another."
    assert split_for_speech(text, "en", 300) == [text]


def test_split_for_speech_cuts_an_overlong_sentence_at_clauses() -> None:
    clause = "the lamp burned on the sill for whoever came after them"
    text = ", ".join([clause] * 8) + "."
    pieces = split_for_speech(text, "en", 150)
    assert len(pieces) > 1 and all(len(piece) <= 150 for piece in pieces)
    assert pieces[0].endswith(",")  # cut after clause punctuation


def test_split_for_speech_zero_limit_means_one_request() -> None:
    text = (_SENTENCE * 8).strip()
    assert split_for_speech(text, "en", 0) == [text]
