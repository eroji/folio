"""audio.text_key and audio.marks: sentence-per-request clips.

Every sentence is now its own TTS request. ``marks`` records where each one
starts in the joined clip (read-along follows them); ``text_key`` identifies
what was said regardless of how it was split, so a ready segment keeps its
clip when only the split changes.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audio", sa.Column("text_key", sa.String(64), nullable=True))
    op.add_column("audio", sa.Column("marks", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("audio", "marks")
    op.drop_column("audio", "text_key")
