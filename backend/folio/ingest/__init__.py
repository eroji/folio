"""Book ingestion primitives (Task 5a): format detection and EPUB/PDF/Kindle extraction.

Shared result types and the two ingest exceptions live here so the per-format
readers can import them without circular dependencies.
"""

from dataclasses import dataclass, field

DRM_MESSAGE = "This file is DRM-protected or in an unsupported Kindle format"


@dataclass
class ExtractedChapter:
    title: str
    text: str
    # Front/back matter (copyright, contents, acknowledgments, ads...) starts
    # turned off; the owner can turn it back on under Manage.
    excluded: bool = False


@dataclass
class EmbeddedMetadata:
    title: str | None = None
    authors: list[str] = field(default_factory=list)
    language: str | None = None
    publisher: str | None = None
    published_date: str | None = None
    description: str | None = None
    isbn10: str | None = None
    isbn13: str | None = None
    series: str | None = None
    series_index: float | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class ExtractedBook:
    chapters: list[ExtractedChapter]
    metadata: EmbeddedMetadata
    cover: bytes | None = None


class UnsupportedFormat(Exception):
    """File cannot be ingested; code is one of drm, kfx, unknown."""

    def __init__(self, code: str) -> None:
        super().__init__(DRM_MESSAGE)
        self.code = code


class ScannedPDF(Exception):
    """PDF averages under 200 extractable characters per page (needs OCR later).

    Carries whatever metadata/cover was still readable so the pipeline can add
    the book as ``needs_ocr`` instead of discarding it (spec, ingestion step 5).
    """

    def __init__(
        self,
        message: str,
        metadata: EmbeddedMetadata | None = None,
        cover: bytes | None = None,
    ) -> None:
        super().__init__(message)
        self.metadata = metadata
        self.cover = cover
