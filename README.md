# Folio

Folio is a self-hosted, mobile-first web app that turns uploaded ebooks — EPUB, PDF, Kindle (MOBI/AZW3) — into a shared catalog of audiobooks you can listen to on any device. Speech is generated on demand by a remote OpenAI-compatible TTS endpoint and cached on disk, so every segment is synthesized once and reused across books, users and playback speeds. Listening progress is stored per user per book and resumes exactly where you stopped, on any device.

Users sign in with their existing LDAP / Active Directory account; Folio stores no passwords and maps roles (`admin` / `user`) from directory group membership. Everything runs as two containers built from one image — an API (which also serves the built React PWA) and a background worker — plus PostgreSQL 16 and a single `/data` volume, deployed with Docker Compose behind nginx. No Redis, no hosted model: the job queue lives in the `jobs` table and Folio is only a client of the TTS API.

Delivered so far: **M1** (compose stack, schema + migrations, LDAP auth, roles), **M2** (upload → ingest pipeline, chapters/segments, SSE status), **M3** (online metadata from Open Library/Google Books, editable fields that survive re-ingest, cover upload/URL/crop with 600 px and 200 px WebP variants), **M4** (on-demand TTS through a verified OpenAI-compatible backend, disk cache, gapless two-element player, mini player, line-level read-along with auto-scroll, Media Session, voice picker with previews), and **M5** (per-user progress saved every 10 s and on pause/hide, 3 s rewind on resume, cross-device prompt, Continue listening row, finished/reset, and server-synced listening settings). PWA polish, admin tools and the accessibility pass (M6) are **roadmap**. Live status per milestone: [`docs/MILESTONES.md`](docs/MILESTONES.md).

Audio needs a TTS backend: set `TTS_BASE_URL` (and `TTS_DEFAULT_VOICE` if you don't want the config default). The verified homelab engine and its contract are documented in [`docs/TTS.md`](docs/TTS.md).

## Architecture

```
browser (PWA) ── HTTPS ──▶ nginx ──▶ api :8000   (FastAPI + built SPA, /healthz, SSE)
                                        │  ▲
                       LISTEN/NOTIFY    │  │ claims jobs with
                       status → SSE     ▼  │ SELECT … FOR UPDATE SKIP LOCKED
                                     db :5432 ◀──── worker  (python -m folio.worker,
                              (PostgreSQL 16:      ingest pipeline, heartbeat file)
                               users, sessions,
                               books, chapters,          │
                               segments, jobs; audio/    │
                               progress in M4–M5)        ▼
                                                   /data volume
                                                   books/<id>/original.<ext>,
                                                   covers/, audio/<kk>/<key>.<ext>

external: LDAP/AD (login + roles) · OpenAI-compatible TTS API (roadmap, M4)
```

One OCI image (multi-stage: Node build → Python 3.12 runtime with Calibre) runs both the `api` and `worker` services as a non-root user; `db` is `postgres:16`. Migrations run automatically at API start-up.

## Local development

```bash
make install            # once: create backend/.venv, install pinned deps
cp .env.example .env    # fill in FOLIO_BASE_URL, FOLIO_SECRET_KEY, LDAP_* (required)
make db                 # start only the postgres service (localhost:5432)
make dev-backend        # alembic upgrade head + uvicorn --reload on :8000
make dev-web            # vite dev server on :5173, proxies /api to :8000
```

Open <http://localhost:5173>. Both sides hot-reload. Local dev writes uploads to `./data` (from `.env`); the compose stack overrides `DATA_DIR` to the `/data` volume.

If the server has no LDAP directory to point at, start the test stack and use the **"Test mode: sign in without LDAP"** panel on the login page (pick `user` or `admin`). It exists only when `FOLIO_TEST_MODE=true`, which `compose.test.yaml` — and nothing else — sets:

```bash
docker compose -f compose.yaml -f compose.test.yaml up -d --build
# then open http://localhost:8000/login
```

With a real directory, fill `LDAP_*` in `.env` and use the normal form; `DOMAIN\user`, `user@domain` and `user` all work.

## Local testing

```bash
make test       # backend pytest (starts the db container if needed)
make test-web   # frontend vitest
make e2e        # clean stack via compose.test.yaml + Playwright
make fixtures   # regenerate the seven gitignored test books
make lint       # ruff + mypy + eslint + tsc --noEmit

# Milestone acceptance against a running stack (needs FOLIO_TEST_MODE=true)
BASE=http://localhost:8000 ./scripts/acceptance.sh
```

`make e2e` recreates the volumes on purpose: the suite asserts the empty library and uploads a fixture that content-hash dedupe would reject on a reused database. It needs Playwright's browser once (`cd frontend && npx playwright install chromium`).

LDAP and TTS are faked or pointed at the mock server in every test; no test ever reaches a real directory or TTS backend. Real LDAP/TTS values come only from `.env`. Backend tests use `TEST_DATABASE_URL` (default `postgresql+psycopg://folio:folio@localhost:5432/folio_test`, created if missing) — never point it at a dev or production database. `FOLIO_TEST_MODE` is set only by `compose.test.yaml`.

## Deploy to a server

The target runs Docker Compose; nothing needs Python, Node or Calibre on the host.

```bash
# 1. put a real .env on the host (every required var; see docs/CONFIG.md)
# 2a. build on the host (simplest; needs Docker only)
docker compose up -d --build
# 2b. or pull a published image from Harbor (set FOLIO_IMAGE in .env)
#     FOLIO_IMAGE=harbor.example.com/library/folio:1.2.3
docker compose pull && docker compose up -d
# 3. verify
curl -fsS http://<host>/healthz
docker compose ps
```

The first admin is simply the first person whose directory account is in the group set as `FOLIO_LDAP_ADMIN_GROUP`; there is no local admin bootstrap. Inspect logs with `make logs` (api + worker).

**Upgrade:** point the `image:` in `compose.yaml` at the new tag in the registry, then `docker compose pull && docker compose up -d`. **Rollback:** set the previous tag and `docker compose up -d`. Backups and restores (Postgres dump + `/data` volume) are in [`docs/BACKUP.md`](docs/BACKUP.md).

## nginx reverse proxy

`client_max_body_size` must be at least `MAX_UPLOAD_MB` (default 200), and the SSE endpoint must not be buffered.

```nginx
server {
    listen 443 ssl http2;
    server_name folio.example.com;

    client_max_body_size 200m;   # >= MAX_UPLOAD_MB

    location / {
        proxy_pass http://127.0.0.1:8000;   # the api container's published port
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket upgrade headers (Folio uses SSE today; harmless, future-proof)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Server-Sent Events: stream, never buffer
    location /api/v1/events {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";     # keep the stream alive
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```
