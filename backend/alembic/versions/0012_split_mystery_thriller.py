"""Split the combined "Mystery & thriller" genre into "Mystery" and "Thriller".

Existing rows are re-derived from their subject tags where possible; anything
else falls back to "Mystery" (the bucket that used to hold both).

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from folio.metadata.service import genre_from_subjects

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, tags FROM books WHERE genre = 'Mystery & thriller'")
    ).all()
    for book_id, tags in rows:
        genre = genre_from_subjects(tags or []) or "Mystery"
        bind.execute(
            sa.text("UPDATE books SET genre = :genre WHERE id = :id"),
            {"genre": genre, "id": book_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE books SET genre = 'Mystery & thriller' WHERE genre IN ('Mystery', 'Thriller')"
        )
    )
