"""audio and segment_audio (spec Tables + M4 plan data model)."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from folio.db import Base


class Audio(Base):
    """One synthesized clip, keyed by sha256(model|voice|format|text)."""

    __tablename__ = "audio"
    __table_args__ = (Index("ix_audio_last_played_at", "last_played_at"),)

    cache_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    format: Mapped[str] = mapped_column(String(16), nullable=False)
    voice: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    duration_s: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # What was said, how and by which engine, ignoring how it was split into
    # requests (the key without ``|req=``): a ready segment keeps its clip
    # while this matches. Null for clips made before it existed.
    text_key: Mapped[str | None] = mapped_column(String(64))
    # Where each request's audio starts in the clip: ``[[text_fraction,
    # seconds], ...]`` from ``[0, 0]``; read-along follows these. Null for a
    # clip made as one request.
    marks: Mapped[list[list[float]] | None] = mapped_column(JSONB)


class SegmentAudio(Base):
    """Per-segment generation state; doubles as the TTS queue (plan Wave 1)."""

    __tablename__ = "segment_audio"
    __table_args__ = (
        UniqueConstraint("segment_id", "voice", name="uq_segment_audio_segment_id_voice"),
        Index("ix_segment_audio_status_priority", "status", "priority"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    segment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("segments.id", ondelete="CASCADE"), nullable=False
    )
    voice: Mapped[str] = mapped_column(String(64), nullable=False)
    cache_key: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("audio.cache_key", ondelete="SET NULL")
    )
    # queued | generating | ready | failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    error: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
