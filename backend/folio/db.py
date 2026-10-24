"""Engine, session factory, and declarative Base. Sync SQLAlchemy 2.x + psycopg 3."""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from folio.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding one session per request."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
