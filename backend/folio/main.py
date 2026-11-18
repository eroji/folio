"""App factory: /healthz, admin health, error handlers, static SPA fallback."""

import logging
import time
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text as sa_text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.deps import get_current_user
from folio.errors import ApiError, register_error_handlers
from folio.metrics import HttpMetricsMiddleware
from folio.metrics import router as metrics_router
from folio.models import User
from folio.routers.admin import probe_tts
from folio.routers.admin import router as admin_router
from folio.routers.audio import router as audio_router
from folio.routers.auth import router as auth_router
from folio.routers.books import router as books_router
from folio.routers.covers import router as covers_router
from folio.routers.events import router as events_router
from folio.routers.integrations import router as integrations_router
from folio.routers.me import router as me_router
from folio.routers.metadata import router as metadata_router
from folio.routers.progress import router as progress_router
from folio.routers.pronunciation import router as pronunciation_router
from folio.routers.search import router as search_router
from folio.routers.voices import router as voices_router

WORKER_HEARTBEAT_MAX_AGE_S = 60
STATIC_DIR = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)


def admin_health(
    session: Annotated[DbSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> JSONResponse:
    settings = get_settings()
    try:
        session.execute(sa_text("SELECT 1"))
        db: str = "ok"
    except SQLAlchemyError:
        db = "unreachable"
    heartbeat = settings.data_dir / ".worker-heartbeat"
    try:
        age = time.time() - heartbeat.stat().st_mtime
        worker = "ok" if age < WORKER_HEARTBEAT_MAX_AGE_S else "stale"
    except OSError:
        worker = "missing"
    body: dict[str, Any] = {"db": db, "worker": worker, "tts": probe_tts(settings)}
    return JSONResponse(status_code=200 if db == "ok" else 503, content=body)


# The app shell revalidates on every load: without a Cache-Control header iOS
# reused a heuristically cached index.html, and installed PWAs kept the old UI
# after a deploy. version.json is what the app polls to notice a new build.
_REVALIDATE = frozenset({"index.html", "sw.js", "version.json", "site.webmanifest"})


class _ImmutableStaticFiles(StaticFiles):
    """/assets: Vite puts a content hash in every file name, so cache for good."""

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def create_app() -> FastAPI:
    app = FastAPI(title="Folio", version="0.1.0")
    register_error_handlers(app)
    app.add_middleware(HttpMetricsMiddleware)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(metrics_router)
    app.add_api_route("/api/v1/admin/health", admin_health, methods=["GET"])
    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(integrations_router)
    app.include_router(covers_router)
    app.include_router(books_router)
    app.include_router(search_router)
    app.include_router(pronunciation_router)
    app.include_router(progress_router)
    app.include_router(me_router)
    app.include_router(metadata_router)
    app.include_router(events_router)
    app.include_router(audio_router)
    app.include_router(voices_router)

    if get_settings().folio_test_mode:
        from folio.routers.test_auth import router as test_auth_router

        logger.warning("FOLIO_TEST_MODE is enabled: unauthenticated test login is mounted")
        app.include_router(test_auth_router)

    # Serve the compiled SPA last so /api and /healthz win. Deep links
    # (/login, /books/:id) fall back to index.html for client-side routing.
    index = STATIC_DIR / "index.html"
    if index.is_file():
        if (STATIC_DIR / "assets").is_dir():
            app.mount(
                "/assets", _ImmutableStaticFiles(directory=STATIC_DIR / "assets"), name="assets"
            )

        @app.api_route(
            "/api/{path:path}",
            methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            include_in_schema=False,
        )
        def api_not_found(path: str) -> None:
            raise ApiError("not_found", "Not found.", 404)

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (STATIC_DIR / path).resolve()
            if path and candidate.is_file() and candidate.is_relative_to(STATIC_DIR.resolve()):
                if candidate.name in _REVALIDATE:
                    return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
