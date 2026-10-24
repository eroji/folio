# Folio

Folio is a self-hosted, mobile-first web app that turns uploaded ebooks — EPUB, PDF, Kindle (MOBI/AZW3) — into a shared catalog of audiobooks you can listen to on any device. Speech is generated on demand by a remote OpenAI-compatible TTS endpoint and cached on disk, so every segment is synthesized once and reused across books, users and playback speeds. Listening progress is stored per user per book and resumes exactly where you stopped, on any device.

Users sign in with their existing LDAP / Active Directory account; Folio stores no passwords and maps roles (`admin` / `user`) from directory group membership. Everything runs as two containers built from one image — an API (which also serves the built React PWA) and a background worker — plus PostgreSQL 16 and a single `/data` volume, deployed with Docker Compose behind nginx. No Redis, no hosted model: the job queue lives in the `jobs` table and Folio is only a client of the TTS API.

Current state: milestones M1–M2 (compose stack, schema + migrations, LDAP auth, upload → ingest pipeline). Metadata editing and cover tools (M3), the TTS player (M4), progress and settings (M5), and PWA polish + admin tools (M6) are **roadmap**, not yet available. See [`docs/MILESTONES.md`](docs/MILESTONES.md).

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
                               segments, audio,          │
                               progress, jobs)           ▼
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

## Local testing

```bash
make test       # backend pytest (starts the db container if needed)
make test-web   # frontend vitest
make e2e        # full stack via compose.test.yaml + Playwright
make fixtures   # regenerate the seven gitignored test books
make lint       # ruff + mypy + eslint + tsc --noEmit
```

LDAP and TTS are faked or pointed at the mock server in every test; no test ever reaches a real directory or TTS backend. Real LDAP/TTS values come only from `.env`. Backend tests use `TEST_DATABASE_URL` (default `postgresql+psycopg://folio:folio@localhost:5432/folio_test`, created if missing) — never point it at a dev or production database. `FOLIO_TEST_MODE` is set only by `compose.test.yaml`.

## Deploy to a server

The target runs Docker Compose; nothing needs Python, Node or Calibre on the host.

```bash
# 1. put a real .env on the host (every required var; see docs/CONFIG.md)
# 2. start the stack — migrations run automatically on API start-up
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
