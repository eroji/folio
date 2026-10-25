"""books, book_files, chapters, segments, jobs (spec Tables section)."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Connection,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from folio.db import Base

# Full-text search over books (spec: index full-text search on books).
# Postgres has no IMMUTABLE array→text function (array_to_string is STABLE),
# so the indexed expression goes through this wrapper. The same expression is
# used by search queries (Task 8) so the GIN index is hit.
BOOK_SEARCH_FUNC_SQL = """
CREATE OR REPLACE FUNCTION folio_book_search_vector(t text, s text, a text[], g text[])
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$SELECT to_tsvector('simple', t || ' ' || array_to_string(a, ' ') || ' ' || coalesce(s, '') || ' ' || array_to_string(g, ' '))$$
"""
BOOK_SEARCH_EXPR = "folio_book_search_vector(title, series, authors, tags)"


@event.listens_for(Base.metadata, "before_create")
def _create_book_search_function(metadata: MetaData, connection: Connection, **kw: object) -> None:
    """Keep create_all (test harness) able to build ix_books_search."""
    if connection.dialect.name == "postgresql":
        connection.execute(text(BOOK_SEARCH_FUNC_SQL))


class Book(Base):
    __tablename__ = "books"
    __table_args__ = (Index("ix_books_search", text(BOOK_SEARCH_EXPR), postgresql_using="gin"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    subtitle: Mapped[str | None] = mapped_column(String(512))
    authors: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, server_default=text("'{}'")
    )
    series: Mapped[str | None] = mapped_column(String(255))
    series_index: Mapped[float | None] = mapped_column(Float)
    description: Mapped[str | None] = mapped_column(Text)
    publisher: Mapped[str | None] = mapped_column(String(255))
    # Year-only dates are allowed, so this stays a string.
    published_date: Mapped[str | None] = mapped_column(String(32))
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="en")
    isbn10: Mapped[str | None] = mapped_column(String(17))
    isbn13: Mapped[str | None] = mapped_column(String(13))
    tags: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, server_default=text("'{}'")
    )
    # Direction D: free-text genre (the config.GENRES list is a suggestion, not a constraint).
    genre: Mapped[str | None] = mapped_column(Text)
    narrator_voice: Mapped[str | None] = mapped_column(String(64))
    cover_key: Mapped[str | None] = mapped_column(String(255))
    # Dominant cover color as "R G B" for the page glow; null until a cover is stored.
    cover_rgb: Mapped[str | None] = mapped_column(Text)
    # uploading → processing → ready | needs_ocr | failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="uploading")
    error: Mapped[str | None] = mapped_column(Text)
    locked_fields: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, server_default=text("'{}'")
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL")
    )
    total_chars: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    est_duration_s: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class BookFile(Base):
    __tablename__ = "book_files"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    book_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("books.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # original | converted
    format: Mapped[str] = mapped_column(String(16), nullable=False)
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Indexed for the sha256 dedupe lookup in the ingest pipeline (spec step 1).
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)


class Chapter(Base):
    __tablename__ = "chapters"
    __table_args__ = (UniqueConstraint("book_id", "idx"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    book_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("books.id", ondelete="CASCADE"), nullable=False
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Front matter / appendices the listener never plays; excluded from
    # totals, playback ordering and the detail listing.
    excluded: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )


class Segment(Base):
    __tablename__ = "segments"
    __table_args__ = (Index("ix_segments_chapter_idx", "chapter_id", "idx", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    chapter_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    char_start: Mapped[int] = mapped_column(Integer, nullable=False)
    char_end: Mapped[int] = mapped_column(Integer, nullable=False)


class PronunciationRule(Base):
    """Per-book text substitution applied before speech normalization (spec:
    TTS → Text preparation). Applied in creation order."""

    __tablename__ = "pronunciation_rules"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    book_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("books.id", ondelete="CASCADE"), nullable=False, index=True
    )
    match: Mapped[str] = mapped_column(String(200), nullable=False)
    say: Mapped[str] = mapped_column(String(200), nullable=False)
    whole_word: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    after_number: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    case_sensitive: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    book_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("books.id", ondelete="CASCADE")
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
