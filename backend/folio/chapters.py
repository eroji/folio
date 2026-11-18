"""Chapter titles as listeners see them.

A chapter whose source has no title (an EPUB spine document missing from the
table of contents, a PDF without an outline) is stored with an empty title and
shown as "Chapter N", N being its position among the chapters set to narrate:
the same 1..N the book page and Home cards number them by. Numbering by source
position put "Chapter 7" first once the front matter was turned off.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from folio.models import Chapter

UNTITLED_EXCLUDED = "Untitled section"


def display_titles(chapters: Iterable[Chapter]) -> dict[UUID, str]:
    """``chapter.id -> title`` for one book's chapters (all of them, so the
    numbering sees every exclusion)."""
    titles: dict[UUID, str] = {}
    position = 0
    for chapter in sorted(chapters, key=lambda c: c.idx):
        if not chapter.excluded:
            position += 1
        title = chapter.title.strip()
        if title:
            titles[chapter.id] = title
        else:
            titles[chapter.id] = UNTITLED_EXCLUDED if chapter.excluded else f"Chapter {position}"
    return titles
