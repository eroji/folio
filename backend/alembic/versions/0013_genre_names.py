"""Rename genres to the shorter labels and drop the literature buckets.

Existing values are renamed in place. Books in the removed Japanese/Korean/
Chinese literature buckets are re-derived from their subject tags (usually
"Fiction"); anything untagged becomes NULL ("No genre yet").

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op
from folio.metadata.service import genre_from_subjects

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RENAMES = {
    "Literary fiction": "Fiction",
    "Science fiction": "Science Fiction",
    "Gothic & horror": "Horror",
    "Historical fiction": "Historical Fiction",
    "Biography & memoir": "Biography",
    "Children's": "Children",
}
REMOVED = ("Japanese literature", "Korean literature", "Chinese literature")


def upgrade() -> None:
    bind = op.get_bind()
    for old, new in RENAMES.items():
        bind.execute(
            sa.text("UPDATE books SET genre = :new WHERE genre = :old"),
            {"old": old, "new": new},
        )
    rows = bind.execute(
        sa.text("SELECT id, tags FROM books WHERE genre IN :removed").bindparams(
            sa.bindparam("removed", expanding=True)
        ),
        {"removed": list(REMOVED)},
    ).all()
    for book_id, tags in rows:
        bind.execute(
            sa.text("UPDATE books SET genre = :genre WHERE id = :id"),
            {"genre": genre_from_subjects(tags or []), "id": book_id},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for old, new in RENAMES.items():
        bind.execute(
            sa.text("UPDATE books SET genre = :old WHERE genre = :new"),
            {"old": old, "new": new},
        )
