"""pronunciation_rules: per-book text substitutions before speech.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-24
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pronunciation_rules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("book_id", sa.Uuid(), nullable=False),
        sa.Column("match", sa.String(length=200), nullable=False),
        sa.Column("say", sa.String(length=200), nullable=False),
        sa.Column("whole_word", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("after_number", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("case_sensitive", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["book_id"], ["books.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_pronunciation_rules_book_id", "pronunciation_rules", ["book_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_pronunciation_rules_book_id", table_name="pronunciation_rules")
    op.drop_table("pronunciation_rules")
