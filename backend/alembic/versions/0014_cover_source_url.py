"""books.cover_source_url: remember the provider URL of an applied cover.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("books", sa.Column("cover_source_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("books", "cover_source_url")
