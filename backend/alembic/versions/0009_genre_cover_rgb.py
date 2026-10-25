"""Direction D data: books.genre and books.cover_rgb.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-25
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("books", sa.Column("genre", sa.Text(), nullable=True))
    op.add_column("books", sa.Column("cover_rgb", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("books", "cover_rgb")
    op.drop_column("books", "genre")
