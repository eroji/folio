"""Chapter exclusion: PATCH toggle, totals recompute, detail/segments/queue/progress."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from factories import make_user
from sqlalchemy import select
from sqlalchemy.orm import Session

from folio.config import Settings, get_settings
from folio.errors import ApiError
from folio.models import Book, Chapter, Segment, User
from folio.tts.queue import prepare

CHARS = 100


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _seed(db: Session, *, uploaded_by: UUID | None = None, chapters: int = 3) -> Book:
    cps = get_settings().tts_chars_per_second
    book = Book(
        title="Excluded Book",
        language="en",
        status="ready",
        uploaded_by=uploaded_by,
        total_chars=CHARS * chapters,
        est_duration_s=CHARS * chapters / cps,
    )
    db.add(book)
    db.flush()
    for ci in range(chapters):
        chapter = Chapter(book_id=book.id, idx=ci, title=f"Chapter {ci}", char_count=CHARS)
        db.add(chapter)
        db.flush()
        for si, char_start in enumerate((0, CHARS // 2)):
            db.add(
                Segment(
                    chapter_id=chapter.id,
                    idx=si,
                    text=f"Segment {ci}-{si}.",
                    char_start=char_start,
                    char_end=char_start + CHARS // 2,
                )
            )
    db.commit()
    return book


def _testuser(db: Session) -> User:
    db.expire_all()
    user = db.scalar(select(User).where(User.username == "testuser"))
    assert user is not None
    return user


def _chapters(db: Session, book: Book) -> list[Chapter]:
    db.expire_all()
    return list(db.scalars(select(Chapter).where(Chapter.book_id == book.id).order_by(Chapter.idx)))


def _segments_of(db: Session, book: Book, chapter: Chapter | None = None) -> list[Segment]:
    db.expire_all()
    stmt = (
        select(Segment)
        .join(Chapter, Segment.chapter_id == Chapter.id)
        .where(Chapter.book_id == book.id)
    )
    if chapter is not None:
        stmt = stmt.where(Segment.chapter_id == chapter.id)
    return list(db.scalars(stmt.order_by(Chapter.idx, Segment.idx)))


async def _toggle(
    client: httpx.AsyncClient, book_id: UUID, chapter_id: UUID, excluded: bool
) -> httpx.Response:
    return await client.patch(
        f"/api/v1/books/{book_id}/chapters/{chapter_id}",
        json={"excluded": excluded},
        headers=csrf(client),
    )


async def _put_progress(
    client: httpx.AsyncClient, book: Book, chapter: Chapter, segment: Segment
) -> dict[str, Any]:
    response = await client.put(
        f"/api/v1/books/{book.id}/progress",
        json={
            "chapter_id": str(chapter.id),
            "segment_id": str(segment.id),
            "offset_s": 0.0,
            "device_label": "pytest",
        },
        headers=csrf(client),
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_toggle_permissions_uploader_and_other(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    own = _seed(db, uploaded_by=_testuser(db).id)
    foreign = _seed(db, uploaded_by=make_user(db, username="someoneelse").id)

    response = await _toggle(auth_client, own.id, _chapters(db, own)[0].id, True)
    assert response.status_code == 200, response.text
    assert response.json()["chapter"]["excluded"] is True
    assert (await _toggle(auth_client, own.id, _chapters(db, own)[0].id, False)).status_code == 200

    forbidden = await _toggle(auth_client, foreign.id, _chapters(db, foreign)[0].id, True)
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "forbidden"


async def test_toggle_permissions_admin_edits_foreign_book(
    admin_client: httpx.AsyncClient, db: Session
) -> None:
    foreign = _seed(db, uploaded_by=make_user(db, username="someoneelse").id)
    as_admin = await _toggle(admin_client, foreign.id, _chapters(db, foreign)[0].id, True)
    assert as_admin.status_code == 200, as_admin.text
    assert as_admin.json()["chapter"]["excluded"] is True


async def test_toggle_requires_csrf_and_404s_bad_ids(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _seed(db, uploaded_by=_testuser(db).id)
    chapter = _chapters(db, book)[0]
    assert (await _toggle(auth_client, uuid4(), chapter.id, True)).status_code == 404
    assert (await _toggle(auth_client, book.id, uuid4(), True)).status_code == 404
    other = _seed(db)
    mismatched = await _toggle(auth_client, book.id, _chapters(db, other)[0].id, True)
    assert mismatched.status_code == 404
    no_csrf = await auth_client.patch(
        f"/api/v1/books/{book.id}/chapters/{chapter.id}", json={"excluded": True}
    )
    assert no_csrf.status_code == 403
    assert no_csrf.json()["error"]["code"] == "csrf_failed"


async def test_excluded_chapter_flagged_in_detail_and_404s_segments(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    book = _seed(db, uploaded_by=_testuser(db).id)
    middle = _chapters(db, book)[1]
    assert (await _toggle(auth_client, book.id, middle.id, True)).status_code == 200

    detail = await auth_client.get(f"/api/v1/books/{book.id}")
    assert detail.status_code == 200, detail.text
    body: dict[str, Any] = detail.json()
    # All chapters stay listed; the flag tells the UI which to hide.
    assert [(c["idx"], c["excluded"]) for c in body["chapters"]] == [
        (0, False),
        (1, True),
        (2, False),
    ]
    segments = await auth_client.get(f"/api/v1/books/{book.id}/chapters/{middle.id}/segments")
    assert segments.status_code == 404

    assert (await _toggle(auth_client, book.id, middle.id, False)).status_code == 200
    detail = await auth_client.get(f"/api/v1/books/{book.id}")
    assert all(c["excluded"] is False for c in detail.json()["chapters"])
    segments = await auth_client.get(f"/api/v1/books/{book.id}/chapters/{middle.id}/segments")
    assert segments.status_code == 200


async def test_prepare_skips_excluded_chapters(
    db: Session, settings: Settings, auth_client: httpx.AsyncClient
) -> None:
    book = _seed(db, uploaded_by=_testuser(db).id)
    middle = _chapters(db, book)[1]
    assert (await _toggle(auth_client, book.id, middle.id, True)).status_code == 200

    window = prepare(db, settings, book, _segments_of(db, book)[0].id, count=5, voice="ashley-en")
    assert middle.id not in {segment.chapter_id for segment, _ in window}
    assert len(window) == 4  # 2 segments from chapter 0 + 2 from chapter 2
    with pytest.raises(ApiError) as excinfo:
        prepare(
            db, settings, book, _segments_of(db, book, middle)[0].id, count=0, voice="ashley-en"
        )
    assert excinfo.value.status == 404


async def test_totals_and_percent_recompute_on_toggle(
    auth_client: httpx.AsyncClient, db: Session, settings: Settings
) -> None:
    book = _seed(db, uploaded_by=_testuser(db).id)
    chapters = _chapters(db, book)
    last_segment = _segments_of(db, book, chapters[2])[0]

    assert (await _toggle(auth_client, book.id, chapters[0].id, True)).status_code == 200
    detail = (await auth_client.get(f"/api/v1/books/{book.id}")).json()
    assert detail["book"]["total_chars"] == 2 * CHARS
    assert detail["book"]["est_duration_s"] == 2 * CHARS / settings.tts_chars_per_second
    # Chapter 2's first segment now sits at the halfway point of what plays.
    progress = await _put_progress(auth_client, book, chapters[2], last_segment)
    assert progress["progress"]["percent"] == 50.0

    assert (await _toggle(auth_client, book.id, chapters[0].id, False)).status_code == 200
    detail = (await auth_client.get(f"/api/v1/books/{book.id}")).json()
    assert detail["book"]["total_chars"] == 3 * CHARS
    progress = await _put_progress(auth_client, book, chapters[2], last_segment)
    assert progress["progress"]["percent"] == 200 / 300 * 100


async def test_saved_progress_percent_recomputes_when_a_chapter_is_excluded(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    """Excluding an earlier chapter changes the denominator; saved percentages
    must follow without waiting for the listener to move again."""
    book = _seed(db, uploaded_by=_testuser(db).id)
    chapters = _chapters(db, book)
    last = _segments_of(db, book, chapters[2])[0]

    before = await _put_progress(auth_client, book, chapters[2], last)
    assert round(before["progress"]["percent"], 1) == 66.7  # 200 of 300 chars

    assert (await _toggle(auth_client, book.id, chapters[0].id, True)).status_code == 200

    stored = (await auth_client.get(f"/api/v1/books/{book.id}/progress")).json()
    assert round(stored["progress"]["percent"], 1) == 50.0  # 100 of 200 chars
