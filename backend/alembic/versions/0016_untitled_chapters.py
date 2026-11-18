"""Chapters the importer named "Chapter {idx + 1}" get an empty title.

Untitled chapters are now numbered among the chapters set to narrate when
they are shown (folio.chapters.display_titles); the stored placeholder
numbered them by source position, front matter included.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-18
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE chapters SET title = '' WHERE title = 'Chapter ' || (idx + 1)")


def downgrade() -> None:
    op.execute("UPDATE chapters SET title = 'Chapter ' || (idx + 1) WHERE title = ''")
