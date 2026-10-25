"""M6 Task A: admin job retry transitions and audio-cache stats."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest
from sqlalchemy.orm import Session

from folio.models import Audio, Job


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("folio_csrf", "")}


def _job(db: Session, status: str) -> Job:
    job = Job(
        type="ingest",
        status=status,
        finished_at=datetime.now(UTC) if status in ("done", "failed") else None,
        error="boom" if status == "failed" else None,
    )
    db.add(job)
    db.commit()
    return job


@pytest.mark.parametrize("status", ["failed", "done"])
async def test_retry_requeues_finished_jobs(
    admin_client: httpx.AsyncClient, db: Session, status: str
) -> None:
    job = _job(db, status)
    response = await admin_client.post(
        f"/api/v1/admin/jobs/{job.id}/retry", headers=csrf(admin_client)
    )
    assert response.status_code == 202, response.text
    body = response.json()["job"]
    assert body["id"] == str(job.id)
    assert body["status"] == "queued" and body["error"] is None and body["finished_at"] is None


@pytest.mark.parametrize("status", ["queued", "running"])
async def test_retry_conflicts_on_live_jobs(
    admin_client: httpx.AsyncClient, db: Session, status: str
) -> None:
    job = _job(db, status)
    response = await admin_client.post(
        f"/api/v1/admin/jobs/{job.id}/retry", headers=csrf(admin_client)
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    db.expire_all()
    reloaded = db.get(Job, job.id)
    assert reloaded is not None and reloaded.status == status


async def test_retry_unknown_job_is_404(admin_client: httpx.AsyncClient) -> None:
    response = await admin_client.post(
        f"/api/v1/admin/jobs/{UUID(int=0)}/retry", headers=csrf(admin_client)
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_retry_requires_csrf(admin_client: httpx.AsyncClient, db: Session) -> None:
    job = _job(db, "failed")
    response = await admin_client.post(f"/api/v1/admin/jobs/{job.id}/retry")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"


async def test_retry_requires_admin(auth_client: httpx.AsyncClient, db: Session) -> None:
    job = _job(db, "failed")
    response = await auth_client.post(
        f"/api/v1/admin/jobs/{job.id}/retry", headers=csrf(auth_client)
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


async def test_cache_stats(admin_client: httpx.AsyncClient, db: Session) -> None:
    db.add_all(
        [
            Audio(
                cache_key="a" * 64,
                path="/nope/a.opus",
                format="opus",
                voice="v",
                model="m",
                bytes=100,
            ),
            Audio(
                cache_key="b" * 64,
                path="/nope/b.opus",
                format="opus",
                voice="v",
                model="m",
                bytes=250,
            ),
        ]
    )
    db.commit()
    response = await admin_client.get("/api/v1/admin/cache")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["files"] == 2 and body["bytes"] == 350
    assert body["tts"]["status"] in {"ok", "unreachable", "not_configured"}
    assert body["tts"]["latency_ms"] is None or isinstance(body["tts"]["latency_ms"], int)
