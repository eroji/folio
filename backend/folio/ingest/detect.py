"""Format detection by magic bytes (never by extension) and EPUB DRM check."""

import zipfile
from enum import StrEnum
from pathlib import Path

EPUB_MIME = b"application/epub+zip"
ENCRYPTION_ENTRY = "META-INF/encryption.xml"


class Format(StrEnum):
    EPUB = "epub"
    PDF = "pdf"
    KINDLE = "kindle"
    KFX = "kfx"
    UNKNOWN = "unknown"


def detect_format(path: Path) -> Format:
    try:
        with path.open("rb") as fh:
            head = fh.read(1024)
    except OSError:
        return Format.UNKNOWN
    if head.startswith(b"%PDF-"):
        return Format.PDF
    if head[:2] == b"PK":
        try:
            with zipfile.ZipFile(path) as zf:
                if zf.read("mimetype").strip() == EPUB_MIME:
                    return Format.EPUB
        except (KeyError, zipfile.BadZipFile, zipfile.LargeZipFile):
            pass
        return Format.UNKNOWN
    if head[60:68] == b"BOOKMOBI":
        return Format.KINDLE
    if b"\xeaDRMION\xee" in head:
        return Format.KFX
    return Format.UNKNOWN


def epub_is_drm_protected(path: Path) -> bool:
    """True when the EPUB ships META-INF/encryption.xml (any real DRM declares it there)."""
    try:
        with zipfile.ZipFile(path) as zf:
            return ENCRYPTION_ENTRY in zf.namelist()
    except zipfile.BadZipFile:
        return False
