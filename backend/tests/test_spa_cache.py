"""SPA cache headers: the app shell must revalidate so a deploy reaches
installed PWAs (iOS reused a heuristically cached index.html until the app was
deleted); content-hashed assets may be cached for good."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from folio import main


@pytest.fixture
def static_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    (tmp_path / "index.html").write_text(
        '<script type="module" src="/assets/index-abc.js"></script>'
    )
    (tmp_path / "sw.js").write_text("self.addEventListener('fetch', () => {});")
    (tmp_path / "version.json").write_text('{"build": "b1"}')
    (tmp_path / "favicon.svg").write_text("<svg></svg>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc.js").write_text("console.log(1)")
    monkeypatch.setattr(main, "STATIC_DIR", tmp_path)
    return tmp_path


async def _get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=main.create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


@pytest.mark.parametrize("path", ["/", "/books/123", "/index.html", "/sw.js", "/version.json"])
async def test_app_shell_always_revalidates(static_dir: Path, path: str) -> None:
    response = await _get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


async def test_hashed_assets_are_immutable(static_dir: Path) -> None:
    response = await _get("/assets/index-abc.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


async def test_other_static_files_keep_default_caching(static_dir: Path) -> None:
    response = await _get("/favicon.svg")
    assert response.status_code == 200
    assert "cache-control" not in response.headers
