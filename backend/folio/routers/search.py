"""Search API (Direction D §5.4): one endpoint for books, authors and series.

One full-text query over the book index feeds everything: authors and series
are grouped from the matched books with counts, so an author card's count is
"books matching this query", which for name queries is the author's shelf.
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session as DbSession

from folio.db import get_session
from folio.deps import get_current_user
from folio.models import Book, Progress, User
from folio.models.book import BOOK_SEARCH_EXPR
from folio.routers.books import _public

router = APIRouter(prefix="/api/v1/search", tags=["search"])

MATCH_LIMIT = 100  # matched books aggregated into author/series groups
BOOKS_LIMIT = 20  # books listed in the response


@router.get("")
def search(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[DbSession, Depends(get_session)],
    q: str = "",
    type: Literal["all", "books", "authors", "series"] = Query(default="all"),
) -> dict[str, Any]:
    term = q.strip()
    if not term:
        return {"top": None, "books": [], "authors": [], "series": []}
    matched = list(
        db.scalars(
            select(Book)
            .where(
                text(f"{BOOK_SEARCH_EXPR} @@ websearch_to_tsquery('simple', :q)").bindparams(q=term)
            )
            .order_by(Book.created_at.desc(), Book.id)
            .limit(MATCH_LIMIT)
        )
    )
    if not matched:
        return {"top": None, "books": [], "authors": [], "series": []}

    author_counts: dict[str, int] = {}
    series_counts: dict[str, int] = {}
    for book in matched:
        for author in book.authors:
            author_counts[author] = author_counts.get(author, 0) + 1
        if book.series:
            series_counts[book.series] = series_counts.get(book.series, 0) + 1

    def by_size(counts: dict[str, int]) -> list[dict[str, Any]]:
        return [
            {"name": name, "count": count}
            for name, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
        ]

    authors = by_size(author_counts) if type in ("all", "authors") else []
    series = by_size(series_counts) if type in ("all", "series") else []
    books = [_public(b, user) for b in matched[:BOOKS_LIMIT]] if type in ("all", "books") else []

    top: dict[str, Any] | None = None
    needle = term.lower()
    if type in ("all", "authors"):
        for entry in authors:
            if needle in entry["name"].lower():
                book_ids = [b.id for b in matched if entry["name"] in b.authors]
                top = {
                    "type": "author",
                    "name": entry["name"],
                    "count": entry["count"],
                    "finished": int(
                        db.scalar(
                            select(func.count())
                            .select_from(Progress)
                            .where(
                                Progress.user_id == user.id,
                                Progress.finished_at.is_not(None),
                                Progress.book_id.in_(book_ids),
                            )
                        )
                        or 0
                    ),
                }
                break
    if top is None and books:
        top = {"type": "book", "book": books[0]}
    return {"top": top, "books": books, "authors": authors, "series": series}
