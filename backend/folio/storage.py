"""Paths under ``settings.data_dir``, built only from UUIDs and hex cache keys.

No user-supplied string ever reaches a path: book ids must parse as UUIDs and
file suffixes/formats must be short alphanumeric values, so ``..`` and ``/``
cannot appear. The final ``is_relative_to`` check is a belt-and-braces guard.
"""

import hashlib
import re
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from folio.config import Settings

CHUNK_SIZE = 1024 * 1024  # 1 MiB
_EXT_RE = re.compile(r"[a-z0-9]{1,8}")
_HEX64_RE = re.compile(r"[0-9a-f]{64}")


def ensure_dirs(path: Path) -> Path:
    """Create ``path`` (and missing parents) with mode 0o750, idempotently."""
    path.mkdir(parents=True, exist_ok=True, mode=0o750)
    return path


def _as_book_id(book_id: UUID | str) -> str:
    """Normalise a book id to its canonical UUID string or raise ValueError."""
    try:
        return str(UUID(str(book_id)))
    except ValueError as exc:
        raise ValueError(f"not a valid book id: {book_id!r}") from exc


def _as_ext(ext: str) -> str:
    """Normalise a file suffix (``.epub`` or ``epub``) or raise ValueError."""
    cleaned = ext.removeprefix(".").lower()
    if not _EXT_RE.fullmatch(cleaned):
        raise ValueError(f"not a valid file suffix: {ext!r}")
    return cleaned


def book_dir(settings: Settings, book_id: UUID | str) -> Path:
    return settings.data_dir / "books" / _as_book_id(book_id)


def original_path(settings: Settings, book_id: UUID | str, ext: str) -> Path:
    return book_dir(settings, book_id) / f"original.{_as_ext(ext)}"


def cover_dir(settings: Settings, book_id: UUID | str) -> Path:
    return settings.data_dir / "covers" / _as_book_id(book_id)


def audio_path(settings: Settings, cache_key: str, fmt: str) -> Path:
    """Spec: ``audio/<key[0:2]>/<key>.<ext>`` with a sha256-hex cache key."""
    key = cache_key.lower()
    if not _HEX64_RE.fullmatch(key):
        raise ValueError(f"not a sha256-hex cache key: {cache_key!r}")
    return settings.data_dir / "audio" / key[:2] / f"{key}.{_as_ext(fmt)}"


def write_original(
    settings: Settings, book_id: UUID | str, suffix: str, stream: BinaryIO
) -> tuple[Path, str, int]:
    """Stream ``stream`` to ``books/<id>/original.<suffix>``, hashing as we go.

    Returns ``(path, sha256_hex, size_bytes)``. Nothing is written outside
    ``data_dir``: every component is validated above and the resolved path is
    re-checked before the file is opened.
    """
    path = original_path(settings, book_id, suffix)
    if not path.resolve().is_relative_to(settings.data_dir.resolve()):
        raise ValueError(f"path escapes data_dir: {path!r}")
    ensure_dirs(path.parent)
    hasher = hashlib.sha256()
    size = 0
    with path.open("wb") as fh:
        while chunk := stream.read(CHUNK_SIZE):
            hasher.update(chunk)
            fh.write(chunk)
            size += len(chunk)
    return path, hasher.hexdigest(), size
