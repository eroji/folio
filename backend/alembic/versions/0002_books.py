"""books, book_files, chapters, segments, jobs.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op
from folio.models.book import BOOK_SEARCH_EXPR, BOOK_SEARCH_FUNC_SQL

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "books",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=False),
        sa.Column("subtitle", sa.String(length=512), nullable=True),
        sa.Column(
            "authors",
            postgresql.ARRAY(sa.String()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("series", sa.String(length=255), nullable=True),
        sa.Column("series_index", sa.Float(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("publisher", sa.String(length=255), nullable=True),
        sa.Column("published_date", sa.String(length=32), nullable=True),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("isbn10", sa.String(length=17), nullable=True),
        sa.Column("isbn13", sa.String(length=13), nullable=True),
        sa.Column(
            "tags", postgresql.ARRAY(sa.String()), server_default=sa.text("'{}'"), nullable=False
        ),
        sa.Column("narrator_voice", sa.String(length=64), nullable=True),
        sa.Column("cover_key", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "locked_fields",
            postgresql.ARRAY(sa.String()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("uploaded_by", sa.Uuid(), nullable=True),
        sa.Column("total_chars", sa.Integer(), nullable=False),
        sa.Column("est_duration_s", sa.Float(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(BOOK_SEARCH_FUNC_SQL)
    op.execute(f"CREATE INDEX ix_books_search ON books USING gin ({BOOK_SEARCH_EXPR})")

    op.create_table(
        "book_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("book_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("format", sa.String(length=16), nullable=False),
        sa.Column("path", sa.String(length=1024), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_book_files_book_id", "book_files", ["book_id"], unique=False)
    op.create_index("ix_book_files_sha256", "book_files", ["sha256"], unique=False)

    op.create_table(
        "chapters",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("book_id", sa.Uuid(), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("book_id", "idx", name="uq_chapters_book_id_idx"),
    )

    op.create_table(
        "segments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("chapter_id", sa.Uuid(), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("char_start", sa.Integer(), nullable=False),
        sa.Column("char_end", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["chapter_id"], ["chapters.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_segments_chapter_idx", "segments", ["chapter_id", "idx"], unique=True)

    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("book_id", sa.Uuid(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("jobs")
    op.drop_index("ix_segments_chapter_idx", table_name="segments")
    op.drop_table("segments")
    op.drop_table("chapters")
    op.drop_index("ix_book_files_sha256", table_name="book_files")
    op.drop_index("ix_book_files_book_id", table_name="book_files")
    op.drop_table("book_files")
    op.execute("DROP INDEX ix_books_search")
    op.execute("DROP FUNCTION IF EXISTS folio_book_search_vector(text, text, text[])")
    op.drop_table("books")
