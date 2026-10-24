"""App factory: /healthz, admin health, error handlers, static SPA fallback."""

import logging
import time
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text as sa_text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session as DbSession

from folio.config import get_settings
from folio.db import get_session
from folio.errors import ApiError, register_error_handlers

WORKER_HEARTBEAT_MAX_AGE_S = 60
STATIC_DIR = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)


def admin_health(
    request: Request, session: Annotated[DbSession, Depends(get_session)]
) -> JSONResponse:
    # TODO(M1): replace the cookie-presence check with real session validation
    # against the sessions table (Task 2 owns auth).
    if not request.cookies.get("folio_session"):
        raise ApiError("unauthenticated", "Authentication required.", 401)
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
    body: dict[str, Any] = {"db": db, "worker": worker, "tts": "not_configured"}
    return JSONResponse(status_code=200 if db == "ok" else 503, content=body)


def create_app() -> FastAPI:
    app = FastAPI(title="Folio", version="0.1.0")
    register_error_handlers(app)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.add_api_route("/api/v1/admin/health", admin_health, methods=["GET"])

    if get_settings().folio_test_mode:
        from folio.routers.test_auth import router as test_auth_router

        logger.warning("FOLIO_TEST_MODE is enabled: unauthenticated test login is mounted")
        app.include_router(test_auth_router)

    # Serve the compiled SPA last so /api and /healthz win. Deep links
    # (/login, /books/:id) fall back to index.html for client-side routing.
    index = STATIC_DIR / "index.html"
    if index.is_file():
        if (STATIC_DIR / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

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
                return FileResponse(candidate)
            return FileResponse(index)

    return app


app = create_app()
