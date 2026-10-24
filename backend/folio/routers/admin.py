"""Admin API: job list and local user directory, read-only, admin-only."""

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from folio.db import get_session
from folio.deps import require_admin
from folio.models import Job, User
from folio.routers.auth import UserPublic

router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])

JOBS_PAGE_SIZE = 100


class JobPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    type: str
    book_id: UUID | None
    priority: int
    status: str
    attempts: int
    error: str | None
    created_at: datetime
    finished_at: datetime | None


@router.get("/jobs")
def list_jobs(db: Annotated[DbSession, Depends(get_session)]) -> dict[str, Any]:
    jobs = db.scalars(select(Job).order_by(Job.created_at.desc()).limit(JOBS_PAGE_SIZE)).all()
    return {"items": [JobPublic.model_validate(j) for j in jobs]}


@router.get("/users")
def list_users(db: Annotated[DbSession, Depends(get_session)]) -> dict[str, Any]:
    users = db.scalars(select(User).order_by(User.username)).all()
    return {"items": [UserPublic.model_validate(u) for u in users]}
