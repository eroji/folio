"""Backfill books.genre from their existing subject tags.

Books imported before genre derivation existed still have tags (e.g. EPUB
dc:subject "Mystery") but a NULL genre, so the Library shows everything under
"No genre yet". The mapping is the same one ingest now uses.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from folio.metadata.service import genre_from_subjects

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, tags FROM books WHERE genre IS NULL AND cardinality(tags) > 0")
    ).all()
    for book_id, tags in rows:
        genre = genre_from_subjects(tags or [])
        if genre:
            bind.execute(
                sa.text("UPDATE books SET genre = :genre WHERE id = :id"),
                {"genre": genre, "id": book_id},
            )


def downgrade() -> None:
    # Data backfill only: the derived values cannot be told apart from manual
    # edits, so there is nothing safe to undo.
    pass
