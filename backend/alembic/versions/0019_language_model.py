"""Language model features: suggested pronunciation rules and a delivery note.

``pronunciation_rules.suggested`` marks a rule the language model proposed; it
changes nothing about the audio until the owner accepts it. ``books.delivery_note``
is the book's narration direction, sent with the voice's style prompt where the
engine takes one.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "pronunciation_rules",
        sa.Column("suggested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("books", sa.Column("delivery_note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("books", "delivery_note")
    op.drop_column("pronunciation_rules", "suggested")
