"""progress: one row per user per book (spec Tables + M5 plan)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from folio.db import Base


class Progress(Base):
    """Last listening position; PK (user_id, book_id) keeps one row per pair."""

    __tablename__ = "progress"
    __table_args__ = (Index("ix_progress_user_id_updated_at", "user_id", "updated_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    book_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("books.id", ondelete="CASCADE"), primary_key=True
    )
    chapter_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False
    )
    segment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("segments.id", ondelete="CASCADE"), nullable=False
    )
    offset_s: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    device_label: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
