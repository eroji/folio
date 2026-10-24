"""Kindle extraction: Calibre `ebook-convert` to EPUB, then the EPUB reader."""

import shutil
import subprocess
from pathlib import Path

from . import EmbeddedMetadata, ExtractedBook, UnsupportedFormat
from .detect import Format, detect_format
from .epub import extract_epub

CONVERT_TIMEOUT_S = 300


def extract_kindle(path: Path, workdir: Path) -> ExtractedBook:
    fmt = detect_format(path)
    if fmt is Format.KFX:
        raise UnsupportedFormat("kfx")
    if fmt is not Format.KINDLE:
        raise UnsupportedFormat("unknown")
    if shutil.which("ebook-convert") is None:
        raise RuntimeError("ebook-convert (Calibre) is required to read Kindle files")
    workdir.mkdir(parents=True, exist_ok=True)
    converted = workdir / "converted.epub"
    subprocess.run(
        ["ebook-convert", str(path), str(converted)],
        timeout=CONVERT_TIMEOUT_S,
        check=True,
    )
    book = extract_epub(converted)
    _fill_missing_metadata(book.metadata, path)
    return book


def _fill_missing_metadata(meta: EmbeddedMetadata, path: Path) -> None:
    """ebook-meta carries fields the converted EPUB loses (series, publisher, ...)."""
    if shutil.which("ebook-meta") is None:
        return
    try:
        result = subprocess.run(
            ["ebook-meta", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return
    simple = {
        "Title": "title",
        "Language": "language",
        "Publisher": "publisher",
        "Published": "published_date",
    }
    for line in result.stdout.splitlines():
        key, sep, value = line.partition(" : ")
        value = value.strip()
        if not sep or not value:
            continue
        key = key.strip()
        if key == "Series" and meta.series is None:
            name, hash_sep, index = value.rpartition(" #")
            if hash_sep:
                meta.series = name.strip()
                try:
                    meta.series_index = float(index)
                except ValueError:
                    pass
        elif key == "Author" and not meta.authors:
            # ponytail: first author only; ebook-meta lists one line per author.
            meta.authors = [value]
        elif key == "Tags" and not meta.tags:
            meta.tags = [tag.strip() for tag in value.split(",") if tag.strip()]
        elif (field := simple.get(key)) and not getattr(meta, field):
            setattr(meta, field, value)
