"""M6 Task A: /metrics exposition, templated path labels, no id/name leakage."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import httpx
import pytest
from prometheus_client import REGISTRY
from sqlalchemy.orm import Session

from folio.config import Settings
from folio.models import Audio, Book, Job
from folio.tts import TtsClient, TtsError

METRIC_NAMES = (
    "folio_http_requests_total",
    "folio_tts_requests_total",
    "folio_tts_request_seconds",
    "folio_jobs",
    "folio_audio_cache_bytes",
    "folio_sse_listeners",
)


async def test_metrics_open_and_exposes_names(client: httpx.AsyncClient) -> None:
    response = await client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain; version=0.0.4")
    for name in METRIC_NAMES:
        assert name in response.text


async def test_uuid_paths_are_labelled_by_route_template(
    auth_client: httpx.AsyncClient,
) -> None:
    book_id = uuid.uuid4()
    assert (await auth_client.get(f"/api/v1/books/{book_id}")).status_code == 404
    body = (await auth_client.get("/metrics")).text
    assert 'path="/api/v1/books/{book_id}"' in body
    assert str(book_id) not in body


async def test_gauges_reflect_db_state_on_scrape(client: httpx.AsyncClient, db: Session) -> None:
    db.add_all(
        [
            Job(type="ingest", status="failed"),
            Job(type="ingest", status="queued"),
            Job(type="ingest", status="queued"),
            Audio(
                cache_key="a" * 64,
                path="/nope/a.opus",
                format="opus",
                voice="v",
                model="m",
                bytes=400,
            ),
        ]
    )
    db.commit()
    body = (await client.get("/metrics")).text
    assert 'folio_jobs{status="queued"} 2.0' in body
    assert 'folio_jobs{status="failed"} 1.0' in body
    assert "folio_audio_cache_bytes 400.0" in body


async def test_metrics_carry_no_titles_or_usernames(
    auth_client: httpx.AsyncClient, db: Session
) -> None:
    db.add(Book(title="Zebra Confidential Title", language="en", status="ready"))
    db.commit()
    await auth_client.get("/api/v1/books")
    await auth_client.get("/api/v1/me/continue")
    body = (await auth_client.get("/metrics")).text
    assert "Zebra Confidential" not in body
    assert "testuser" not in body


def _sample(name: str, labels: dict[str, str] | None = None) -> float:
    return REGISTRY.get_sample_value(name, labels or {}) or 0.0


@pytest.fixture()
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("folio.tts.client.time.sleep", lambda _s: None)


def _tts_client(handler: Callable[[httpx.Request], httpx.Response]) -> TtsClient:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        tts_base_url="http://tts.test/v1",
        tts_model="m",
        tts_format="opus",
        tts_default_voice="v",
    )
    client = TtsClient(settings)
    client._client = httpx.Client(
        transport=httpx.MockTransport(handler), headers=client._client.headers
    )
    return client


def test_tts_synthesize_counts_ok_and_error(_no_sleep: None) -> None:
    ok_before, err_before = (
        _sample("folio_tts_requests_total", {"result": "ok"}),
        _sample("folio_tts_requests_total", {"result": "error"}),
    )
    audio, _fmt = _tts_client(lambda request: httpx.Response(200, content=b"x")).synthesize(
        "hi", "v"
    )
    assert audio == b"x"
    assert _sample("folio_tts_requests_total", {"result": "ok"}) == ok_before + 1

    def failing(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    with pytest.raises(TtsError):
        _tts_client(failing).synthesize("hi", "v")
    assert _sample("folio_tts_requests_total", {"result": "error"}) == err_before + 1
    assert _sample("folio_tts_request_seconds_count") > 0
