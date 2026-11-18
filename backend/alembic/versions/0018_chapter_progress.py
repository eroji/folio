"""chapter_progress: a position and a listened flag per user per chapter.

Backfilled from the one-per-book ``progress`` row: narrated chapters before
the saved one count as heard, the saved one keeps its place, and a finished
book has every narrated chapter heard.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chapter_progress",
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "chapter_id",
            sa.Uuid(),
            sa.ForeignKey("chapters.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "book_id", sa.Uuid(), sa.ForeignKey("books.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("segment_id", sa.Uuid(), sa.ForeignKey("segments.id", ondelete="SET NULL")),
        sa.Column("offset_s", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "ix_chapter_progress_user_id_book_id", "chapter_progress", ["user_id", "book_id"]
    )
    # Heard: narrated chapters before the saved one, or all of a finished book.
    op.execute(
        """
        INSERT INTO chapter_progress (user_id, chapter_id, book_id, offset_s, updated_at,
                                      finished_at)
        SELECT p.user_id, c.id, p.book_id, 0, p.updated_at, p.updated_at
        FROM progress p
        JOIN chapters saved ON saved.id = p.chapter_id
        JOIN chapters c ON c.book_id = p.book_id AND NOT c.excluded
        WHERE c.idx < saved.idx OR p.finished_at IS NOT NULL
        """
    )
    # The saved chapter of an unfinished book keeps its place.
    op.execute(
        """
        INSERT INTO chapter_progress (user_id, chapter_id, book_id, segment_id, offset_s,
                                      updated_at)
        SELECT p.user_id, p.chapter_id, p.book_id, p.segment_id, p.offset_s, p.updated_at
        FROM progress p
        WHERE p.finished_at IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_chapter_progress_user_id_book_id", table_name="chapter_progress")
    op.drop_table("chapter_progress")
