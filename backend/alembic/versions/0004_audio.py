"""audio and segment_audio tables.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-24
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audio",
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("path", sa.String(length=1024), nullable=False),
        sa.Column("format", sa.String(length=16), nullable=False),
        sa.Column("voice", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("duration_s", sa.Float(), nullable=False),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_played_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("cache_key"),
    )
    op.create_index("ix_audio_last_played_at", "audio", ["last_played_at"], unique=False)

    op.create_table(
        "segment_audio",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("segment_id", sa.Uuid(), nullable=False),
        sa.Column("voice", sa.String(length=64), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["segment_id"], ["segments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["cache_key"], ["audio.cache_key"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("segment_id", "voice", name="uq_segment_audio_segment_id_voice"),
    )
    op.create_index(
        "ix_segment_audio_status_priority", "segment_audio", ["status", "priority"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_segment_audio_status_priority", table_name="segment_audio")
    op.drop_table("segment_audio")
    op.drop_index("ix_audio_last_played_at", table_name="audio")
    op.drop_table("audio")
