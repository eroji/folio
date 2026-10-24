# Folio M1–M2 (Foundation, Auth, Ingestion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Folio skeleton, LDAP authentication, and the full upload → ingest → chapter/segment pipeline, with a branded mobile-first shell.

**Architecture:** One FastAPI app (API) plus one Python worker process, sharing one SQLAlchemy 2.x model layer over PostgreSQL 16. Uploads land on the `/data` volume; a `jobs` table claimed with `SELECT … FOR UPDATE SKIP LOCKED` runs ingestion; `LISTEN/NOTIFY` feeds an SSE endpoint. The React PWA is built to static files served by the API container.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2 + pydantic-settings, SQLAlchemy 2.x, Alembic, psycopg 3, httpx, ldap3, ebooklib, BeautifulSoup, PyMuPDF 1.26 (import `pymupdf`, **not** `fitz`), pysbd, Pillow; React 19, Vite 8, TypeScript 5.9, Tailwind 4 (CSS-first `@theme`, **no `tailwind.config.js`**), TanStack Query 5, React Router 7, lucide-react, @fontsource.

**Spec:** `docs/folio-application-spec.md`

## Global Constraints

- Python 3.12, `ruff check` + `ruff format --check` + `mypy` clean; frontend `eslint` + `tsc --noEmit` clean.
- All paths under `DATA_DIR` (default `/data`) are built from IDs, never from user-supplied filenames.
- Every state-changing request requires a valid CSRF header; sessions are server-side rows.
- API errors are always `{"error": {"code": "...", "message": "..."}}` with a real HTTP status.
- Never log passwords, password bind attempts, or full LDAP responses.
- No Redis. No ORM async. No new dependency without a line in `docs/DECISIONS.md`.
- File type is decided by magic bytes, not extension.
- Support target: 10 users, 5,000 books, 200 GB audio. Ingest a 500-page EPUB in < 60 s.
- UI is mobile-first at 390 px; 44×44 px touch targets; Lucide icons at 1.75 px stroke; no emoji.
- **Deployment target:** the app ships as one OCI image run by `docker compose` (`api`, `worker`, `db`) on a server behind nginx; nothing may require a host-installed Python, Node, or Calibre at runtime.
- **Every milestone must be runnable two ways:** locally (`make dev-backend` + `make dev-web` against the compose `db`) and as the full compose stack (`make up`), plus a headless test path (`make test`, `make e2e`). A change that only works in one of those is not done.
- Pin direct dependency versions exactly in `backend/pyproject.toml` and `frontend/package.json`; no floating `^`/`~` for backend deps, and `pip freeze > backend/requirements.lock` after install.

## Review Focus

These are the failure modes the spec implies but no single task's happy-path test covers. Each has a pinning test in the task that owns the code:

1. **Same file uploaded twice** → must return the existing book and a duplicate marker, never a second catalog entry (T8).
2. **DRM-protected / KFX / renamed `.epub` that is really a PDF** → rejected from magic bytes + `META-INF/encryption.xml` with the spec's exact message, never a 500 (T5a, T8).
3. **PDF with running headers/footers** → repeated lines removed before segmentation so they are never spoken (T5a).
4. **A single sentence longer than `TTS_MAX_CHARS`** → split at commas/spaces, never dropped and never emitted over the limit (T5b).
5. **LDAP user who is only in a *nested* group** → still resolves to `user`/`admin` via the in-chain matching rule (T2).

---

## File Structure

```
compose.yaml                       # api + worker + db, volumes, healthchecks
Dockerfile                         # multi-stage: node build -> python runtime + calibre
.env.example                       # every variable from the spec's config table
Makefile                           # up/down/test/lint/fixtures shortcuts
backend/pyproject.toml             # deps, ruff, mypy, pytest config
backend/folio/
  main.py                          # create_app, router mounting, static SPA fallback
  config.py                        # Settings (all FOLIO_*/LDAP_*/TTS_* vars)
  db.py                            # Base, engine, SessionLocal, get_session
  errors.py                        # ApiError + envelope exception handler
  models/{__init__,user,book}.py   # SQLAlchemy models, grouped by domain
  deps.py                          # get_current_user, require_admin, require_editor
  security.py                      # session cookies, CSRF, login rate limiter
  ldap_auth.py                     # LdapAuthenticator protocol + ldap3 implementation
  storage.py                       # all DATA_DIR path construction
  jobs.py                          # enqueue / claim (SKIP LOCKED) / notify
  worker.py                        # `python -m folio.worker` dispatch loop
  events.py                        # LISTEN thread -> asyncio queue for SSE
  routers/{auth,books,admin,events}.py
  ingest/{detect,epub,pdf,kindle,clean,segment,pipeline}.py
backend/alembic/                   # 0001 users+sessions, 0002 books..jobs
backend/tests/                     # conftest + per-unit test modules + fixtures
backend/scripts/make_fixtures.py   # generates the seven fixture books
frontend/                          # Vite + React + TS + Tailwind PWA
  src/styles/tokens.css            # brand tokens, light/dark
  src/api/{client,types}.ts
  src/auth/AuthProvider.tsx, LoginPage.tsx
  src/components/{AppShell,UploadDropzone,EmptyState,BookCard}.tsx
  src/pages/{Library,Upload,BookDetail}Page.tsx
  public/                          # logo.svg, wordmark, PNG icons, manifest
```

**Ownership rule for workstreams:** a task owns the files it lists. `backend/folio/models/__init__.py`, `backend/folio/main.py`, `backend/pyproject.toml`, `compose.yaml` and `frontend/package.json` are *merge-sensitive*: only the task that lists them edits them; the lead resolves any collision at merge time.

---

## Wave 0 — Foundation (blocking, single task)

### Task 1: Repo skeleton, config, schema, packaging

**Files:**
- Create: `backend/pyproject.toml`, `backend/folio/{__init__,main,config,db,errors,models/__init__,models/user,models/book}.py`, `backend/alembic.ini`, `backend/alembic/{env.py,script.py.mako,versions/0001_initial.py,versions/0002_books.py}`, `compose.yaml`, `Dockerfile`, `.env.example`, `Makefile`, `backend/tests/test_health.py`, `backend/tests/test_config.py`
- Test: `backend/tests/test_health.py`

**Interfaces:**
- Produces: `folio.config.Settings` (attributes exactly the env var names lowercased, e.g. `folio_base_url`, `data_dir`, `database_url`, `max_upload_mb`), `folio.config.get_settings() -> Settings`
- Produces: `folio.db.Base`, `folio.db.engine`, `folio.db.SessionLocal`, `folio.db.get_session() -> Iterator[Session]`
- Produces: `folio.errors.ApiError(code: str, message: str, status: int = 400)`
- Produces models: `User(id, ldap_dn, username, display_name, email, role, settings, created_at, last_login_at)`, `Session(id, user_id, csrf_token, user_agent, expires_at)`, `Book(...)` per spec table, `BookFile`, `Chapter`, `Segment`, `Job(id, type, book_id, priority, status, attempts, error, created_at, finished_at)`
- Consumes: nothing

- [ ] **Step 1: Write the failing test** — `test_health.py`: `GET /healthz` returns 200 `{"status": "ok"}` without auth; `GET /api/v1/admin/health` without a session returns 401 with an `error.code` of `unauthenticated`.
- [ ] **Step 2: Run it and confirm failure** — `cd backend && python -m pytest tests/test_health.py -v` → collection error / 404.
- [ ] **Step 3: Scaffold** `pyproject.toml` with the pinned dependency set from the spec plus `psycopg[binary]`, `pydantic-settings`, `pytest`, `pytest-asyncio`, `httpx`, `ruff`, `mypy`. Pin `pymupdf==1.26.7` (2.x removes the legacy `fitz` module) and import `pymupdf`. Generate `backend/requirements.lock` with `pip freeze`. Create `Settings` with `env_file=".env"`, `extra="ignore"`, no defaults for the spec's required vars so start-up fails loudly. Exception (record in `docs/DECISIONS.md`): the `TTS_*` group is optional until M4 and validated when the TTS client is first constructed, so the M1–M2 stack boots without a TTS backend. Add `Base` and `get_session`. Add `ApiError` + handler. Add `create_app()` mounting a `/healthz` route and an admin health router that reports DB reachability (`SELECT 1`), worker liveness (a `worker_heartbeat` row or `last_seen` on jobs — pin: a `heartbeat` key in a tiny `settings_kv` table is overkill; use `SELECT max(finished_at) FROM jobs` and report `"worker": "ok"` when the worker heartbeat file `/data/.worker-heartbeat` is < 60 s old), and TTS reachability (deferred to M4 — return `"tts": "not_configured"`).
- [ ] **Step 4: Add the schema** — `models/user.py` (User, Session), `models/book.py` (Book, BookFile, Chapter, Segment, Job) exactly as the spec's Tables section, with `Mapped[...]` typing, `ARRAY(String)` for authors/tags/locked_fields, `JSONB` for `users.settings`, UUID PKs for books, composite PKs where the spec implies them. Indexes: `segments(chapter_id, idx)`, GIN on `to_tsvector('simple', title || ' ' || array_to_string(authors, ' ') || ' ' || coalesce(series,''))`. Two Alembic revisions: `0001` users+sessions, `0002` the rest.
- [ ] **Step 5: Packaging** — multi-stage `Dockerfile` (node:22 build of `frontend`, then `python:3.12-slim` with calibre, `ebooklib`, PyMuPDF system libs, non-root `folio` user), `compose.yaml` with `api` (`command: sh -c "alembic upgrade head && uvicorn folio.main:app --host 0.0.0.0 --port 8000"`), `worker` (`python -m folio.worker`), `db` (postgres:16 + healthcheck), the two named volumes, `.env.example` containing every row of the spec's configuration table with the spec's defaults, `Makefile` (targets: `db`, `dev-backend`, `dev-web`, `test`, `test-web`, `lint`, `e2e`, `up`, `down`, `logs`, `fixtures`; `test` depends on `db`), and `compose.test.yaml` (overrides: `FOLIO_TEST_MODE=true`, `api` built from local source, db port published) so `make e2e` runs the real stack headlessly. `make up` stays production-shaped: pull/pinned image, no source mounts, no test mode.
- [ ] **Step 6: Verify** — `python -m pytest tests/ -v` passes; `ruff check . && mypy folio` clean; `docker compose config -q` and `docker compose -f compose.yaml -f compose.test.yaml config -q` valid; `alembic upgrade head` against the compose db succeeds and `alembic downgrade base && alembic upgrade head` round-trips; `docker compose build api` completes; `curl localhost:8000/healthz` returns ok from the built image.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: repo skeleton, config, schema, packaging"`.

---

## Wave 1 — Parallel workstreams (after T1 merges)

### Task 2: LDAP authentication, sessions, CSRF, roles

**Files:**
- Create: `backend/folio/ldap_auth.py`, `backend/folio/security.py`, `backend/folio/deps.py`, `backend/folio/routers/auth.py`, `backend/folio/routers/admin.py`, `backend/tests/test_auth.py`, `backend/tests/test_ldap.py`, `backend/tests/test_csrf.py`
- Modify: `backend/folio/models/__init__.py` (export only), `backend/folio/main.py` (mount auth + admin routers) — *lead merges these two edits*
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `Settings`, `get_session`, `ApiError`, `User`, `Session`
- Produces: `class LdapUser(NamedTuple): dn: str; username: str; display_name: str; email: str; groups: list[str]`; `class LdapAuthenticator(Protocol): def authenticate(self, username: str, password: str) -> LdapUser` (raises `InvalidCredentials` / `NotAllowed`); `get_authenticator() -> LdapAuthenticator` FastAPI dependency (overridable in tests)
- Produces: `create_session(session: Session, user: User, user_agent: str) -> tuple[str, str]` (session token, csrf token); `set_session_cookies(response, session_token, csrf_token)`; `clear_session_cookies(response)`; `require_csrf(request, user)`
- Produces: `get_current_user(...) -> User`, `require_admin(user) -> User`, `can_edit_book(user: User, book: Book) -> bool` (admin, or `book.uploaded_by == user.id`)
- Produces endpoints: `POST /api/v1/auth/login` (JSON `{username, password}` → `{user, csrf_token}`), `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` → `{user, csrf_token}`
- Produces: `GET /api/v1/admin/jobs`, `GET /api/v1/admin/users` (read-only, from local `users` table)

- [ ] **Step 1: Write failing tests** — login success sets `folio_session` (HttpOnly, Secure, SameSite=Lax) and `folio_csrf` (readable) cookies and creates one `sessions` row; wrong password → 401 `invalid_credentials` with message `Invalid username or password`; user outside both groups → 403 `not_allowed` with `Your account is not allowed to use Folio`; 11th attempt within 15 min → 429 `locked_out`; `logout` deletes the row; `GET /me` without a cookie → 401 `unauthenticated`; a state-changing request with a missing/wrong `X-CSRF-Token` → 403 `csrf_failed`; role escalation (user hits `/admin/jobs`) → 403 `forbidden`; nested-group membership resolves through the in-chain rule (fake authenticator returns a nested group DN → role `user`).
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `ldap_auth.py`** — `ldap3.Server(settings.ldap_url, use_ssl=url.startswith("ldaps"), tls=Tls(ca_certs_file=settings.ldap_ca_file, validate=Validate.CERT_REQUIRED) unless ldap_allow_insecure)`. Service bind → search `ldap_base_dn` with `ldap_user_filter.format(username=escape_filter_chars(username))` → re-bind as the user DN → read `memberOf` plus `LDAP_MATCHING_RULE_IN_CHAIN` (1.2.840.113556.1.4.1941) for nested groups → compare DNs case-insensitively against `folio_ldap_admin_group` / `folio_ldap_user_group`. Any bind failure maps to `InvalidCredentials`; log only the username and the failure class.
- [ ] **Step 4: Implement sessions/CSRF/rate limit** — 32 random bytes hex session id stored as PK, 30-day sliding expiry refreshed in `get_current_user` at most once per hour; CSRF token is `hmac.new(secret, session_id, sha256)` compared with `secrets.compare_digest`; in-process sliding-window rate limiter keyed by lowercased username with a `# ponytail: single-process limiter, move to a DB table if the API is ever scaled past one uvicorn worker` comment.
- [ ] **Step 5: Wire routes and role dependencies**, register `get_current_user` as a router-level dependency on every router except `auth.login`, `healthz`.
- [ ] **Step 6: Verify** — `pytest tests/test_auth.py tests/test_ldap.py tests/test_csrf.py -v`, `ruff`, `mypy`.
- [ ] **Step 7: Commit** — `feat: LDAP auth, server-side sessions, CSRF, roles`.

### Task 3: Test harness, fixture books, mock TTS server

**Files:**
- Create: `backend/tests/conftest.py`, `backend/tests/factories.py`, `backend/scripts/make_fixtures.py`, `backend/tests/fixtures/.gitignore`, `backend/tests/mock_tts.py`, `backend/pytest.ini` (or `[tool.pytest.ini_options]` in `pyproject.toml` — *lead merges*), `Makefile` target `fixtures`
- Test: `backend/tests/test_harness.py`

**Interfaces:**
- Produces pytest fixtures: `settings` (test overrides: temp `DATA_DIR`, `FOLIO_SECRET_KEY=test`, `FOLIO_TEST_MODE=true`, `TEST_DATABASE_URL` default `postgresql+psycopg://folio:folio@localhost:5432/folio_test`), `db` (creates the `folio_test` database if missing by connecting to the server's `postgres` database, creates schema with `Base.metadata.create_all`, truncates between tests), `client` (httpx `AsyncClient` over `ASGITransport`), `auth_client` (logged-in user via the test-mode session endpoint), `admin_client`, `fixture_books` (dict keyed `epub3, epub2, pdf_outline, pdf_flat, azw3, scanned_pdf, drm_epub` → `Path`)
- Produces: `scripts/make_fixtures.py` generating all seven fixtures into `tests/fixtures/` — EPUB 3 and EPUB 2 built with `ebooklib` from two Project Gutenberg public-domain texts, `pdf_outline` and `pdf_flat` built with PyMuPDF (one with a TOC, one without; both 24+ pages so the 20-page chapter fallback is exercised), `scanned_pdf` = PDF with image-only pages, `drm_epub` = valid EPUB plus `META-INF/encryption.xml`, `azw3` = converted from `epub3` with `ebook-convert` (skipped with a clear message when Calibre is absent). Fixtures themselves are gitignored; `make fixtures` regenerates them.
- Produces: `mock_tts.py` — a stdlib `http.server` on an ephemeral port serving `POST /v1/audio/speech` (returns a 1-second silent Ogg/Opus byte string) and `GET /v1/audio/voices` (returns `{"voices": [{"id": "ashley-en", "language": "en"}]}`)
- Produces: `FOLIO_TEST_MODE` login endpoint `POST /api/v1/test/login` returning a session for a seeded user, mounted only when `settings.folio_test_mode` is true.

- [ ] **Step 1: Write `test_harness.py`** — the `client` fixture reaches `/healthz`; `db` starts empty and is empty again after a test that inserts a user; `fixture_books` contains all seven keys; `mock_tts` answers `/v1/audio/voices`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement conftest + factories + fixture generator + mock server + test-mode router.** Document `TEST_DATABASE_URL` in `docs/CONFIG.md` and the `Makefile`.
- [ ] **Step 4: Verify** — `make fixtures && pytest tests/test_harness.py -v`.
- [ ] **Step 5: Commit** — `test: harness, fixture books, mock TTS server`.

### Task 4: Frontend shell, brand tokens, login

**Files:**
- Create: `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.js`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/tokens.css`, `src/styles/index.css`, `src/api/client.ts`, `src/api/types.ts`, `src/auth/AuthProvider.tsx`, `src/auth/LoginPage.tsx`, `src/components/AppShell.tsx`, `src/components/EmptyState.tsx`, `src/pages/LibraryPage.tsx`, `frontend/public/logo.svg`, `logo-wordmark.svg`, `public/icons/*.png`, `public/manifest.webmanifest`, `frontend/.eslintrc.cjs`
- Test: `frontend/src/auth/LoginPage.test.tsx` (Vitest + Testing Library), `frontend/e2e/login.spec.ts` (Playwright, `FOLIO_TEST_MODE` session)

**Interfaces:**
- Consumes: `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`
- Produces: `api.get/post/patch/del<T>(path, body?)` reading `folio_csrf` from `document.cookie` and sending `X-CSRF-Token`; `useAuth() -> {user, login, logout, isLoading}`; routes `/login`, `/`, `/upload`, `/books/:id`
- Produces: CSS custom properties exactly as the spec's brand table; Tailwind theme mapped to them; `[data-theme="light"|"dark"]` plus `prefers-color-scheme` default

- [ ] **Step 1: Write the failing test** — `LoginPage.test.tsx`: renders the wordmark and "Sign in with your directory account"; submitting bad credentials shows the server message inline; success calls `onSuccess`.
- [ ] **Step 2: Run and confirm failure** — `npm test -- --run`.
- [ ] **Step 3: Scaffold Vite/TS/Tailwind** — pin `react@19.3.1`, `react-dom@19.3.1`, `react-router-dom@7.18.4`, `@tanstack/react-query@5.104.5`, `lucide-react`, `clsx`, `@fontsource-variable/{inter,outfit}`; dev: `vite@8.3.5`, `@vitejs/plugin-react@6.1.2`, `typescript@5.9.3`, `tailwindcss@4.3.3` + `@tailwindcss/vite@4.3.3` (no PostCSS config, no `tailwind.config.js`; brand tokens declared in `tokens.css` with `@theme`), `eslint@10` flat config, `vitest@5`, `jsdom`, `@testing-library/react`, `@playwright/test@1.64.1`. Vite dev proxy `/api` → `http://localhost:8000`, and `build.outDir = "../backend/folio/static"`. Note: React 19 instead of the spec's React 18 — record in `docs/DECISIONS.md`.
- [ ] **Step 4: Implement tokens + shell** — `tokens.css` with `--brand-blue:#2381F7`, `--brand-violet:#8B5CF6`, `--brand-gradient`, `--brand-tint:#8EA2F9`, `--ink:#1E2235`, `--surface-light:#F6F7FB`, `--surface-dark:#12141F`, `--muted` light/dark; 12 px card / 999 px pill radii; safe-area padding. `AppShell` = sticky header (logo, Library/Upload nav, theme toggle, avatar menu with Admin link for admins), bottom nav on phones.
- [ ] **Step 5: Implement auth** — `AuthProvider` bootstraps `/auth/me`, `LoginPage` at 390 px, `RequireAuth` redirects to `/login`; empty `LibraryPage` with the spec's empty-state copy and an Upload button; a minimal `AdminPage` at `/admin` listing `/admin/jobs` (retry arrives in M6) and rendered only for `role === "admin"`, plus the Admin menu item.
- [ ] **Step 6: Generate icons** — rasterize `docs/sample/*.svg` to `logo.svg` (mark only), `logo-wordmark.svg`, `icons/{icon-512,icon-192,apple-touch-icon-180,icon-32}.png`, `icon-maskable-512.png` (mark inside the central 80% safe zone), `favicon.ico`; manifest with `theme_color:#1E2235`, `background_color`, `display:standalone`, `start_url:/`.
- [ ] **Step 7: Verify** — `npm run lint && npx tsc --noEmit && npm test -- --run && npm run build`; `npx playwright test e2e/login.spec.ts` at viewport 390×844 against a running API.
- [ ] **Step 8: Commit** — `feat(web): app shell, brand tokens, LDAP login, PWA manifest`.

### Task 5a: Format detection and book extractors

**Files:**
- Create: `backend/folio/ingest/__init__.py`, `detect.py`, `epub.py`, `pdf.py`, `kindle.py`, `backend/tests/test_detect.py`, `backend/tests/test_extract.py`
- Test: `backend/tests/test_detect.py`, `backend/tests/test_extract.py`

**Interfaces:**
- Consumes: `fixture_books` from T3
- Produces: `class Format(StrEnum): EPUB, PDF, KINDLE, KFX, UNKNOWN`; `detect_format(path: Path) -> Format`
- Produces: `@dataclass class ExtractedChapter: title: str; text: str`; `@dataclass class EmbeddedMetadata: title, authors, language, publisher, published_date, description, isbn10, isbn13, series, series_index, tags`; `@dataclass class ExtractedBook: chapters: list[ExtractedChapter]; metadata: EmbeddedMetadata; cover: bytes | None`
- Produces: `extract_epub(path) -> ExtractedBook`, `extract_pdf(path) -> ExtractedBook` (via `import pymupdf`), `extract_kindle(path, workdir: Path) -> ExtractedBook` (converts to EPUB with `ebook-convert`, 300 s timeout, then delegates)
- Produces: `class UnsupportedFormat(Exception)` with `.code` in `{drm, kfx, unknown}`; `class ScannedPDF(Exception)`

- [ ] **Step 1: Write failing tests** — `detect_format` returns PDF for a PDF renamed to `.epub`, EPUB for a real EPUB, KFX for the `0xEA 'DRMION' 0xEE` magic, KINDLE for BOOKMOBI, UNKNOWN for a text file; `extract_epub` on `epub3` yields the expected chapter count and titles from the nav TOC, and no `<script>`/`<img>` text; `drm_epub` raises `UnsupportedFormat(code="drm")` with message `This file is DRM-protected or in an unsupported Kindle format`; `extract_pdf` on `pdf_outline` returns the outline titles, on `pdf_flat` returns ~20-page chapters; a page header repeated on >50% of pages appears 0 times in the text (use a generated 20-page PDF with a footer on every page); `scanned_pdf` raises `ScannedPDF` when average extractable characters per page < 200; `extract_kindle` on the AZW3 fixture returns chapters (skip if Calibre missing).
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `detect.py`** — read the first 1 KiB: `%PDF-` → PDF; ZIP magic + `zipfile` entry `mimetype` = `application/epub+zip` → EPUB (then DRM check: `META-INF/encryption.xml` present → `drm`); `BOOKMOBI` at offset 60 → KINDLE; `\xeaDRMION\xee` → KFX; else UNKNOWN.
- [ ] **Step 4: Implement EPUB reader** — `ebooklib.read_epub`, spine order, TOC title flattening (nested `tuple`/`list` handling), BeautifulSoup `lxml` text extraction dropping `script, style, img, nav, svg`, footnote back-links (`a` whose href starts `#` and text matches `^[0-9ivx]+$` or has `role=doc-noteref`), and page-break artifacts; OPF metadata + cover (`item type == ITEM_COVER` or `properties` contains `cover-image`).
- [ ] **Step 5: Implement PDF reader** — PyMuPDF: outline from `doc.get_toc()`, else 20-page chunks; per-page line frequency filtering before joining (spec: drop lines repeated on >50% of pages, only when pages ≥ 5); metadata from `doc.metadata`; cover = first embedded image else page-1 pixmap at 2:3.
- [ ] **Step 6: Implement Kindle conversion** — `subprocess.run(["ebook-convert", src, dst], timeout=300, check=True)`; `ebook-meta` for fields EPUB lacks; raise `UnsupportedFormat(code="kfx")` for KFX before conversion.
- [ ] **Step 7: Verify** — `pytest tests/test_detect.py tests/test_extract.py -v`.
- [ ] **Step 8: Commit** — `feat(ingest): format detection and EPUB/PDF/Kindle extraction`.

### Task 5b: Text cleaning and sentence segmentation

**Files:**
- Create: `backend/folio/ingest/clean.py`, `backend/folio/ingest/segment.py`, `backend/tests/test_clean.py`, `backend/tests/test_segment.py`
- Test: `backend/tests/test_segment.py`

**Interfaces:**
- Produces: `clean_text(raw: str, language: str) -> str`, `clean_chapters(chapters: list[ExtractedChapter], language: str) -> list[ExtractedChapter]`
- Produces: `@dataclass class SegmentedSentence: text: str; char_start: int; char_end: int`; `@dataclass class SegmentedChapter: title: str; text: str; sentences: list[SegmentedSentence]; segments: list[SegmentedSentence]`; `segment_chapter(chapter, language, max_chars=800) -> SegmentedChapter`; `split_sentences(text, language) -> list[str]`
- Consumes: `ExtractedChapter` from T5a

- [ ] **Step 1: Write failing tests** — NFKC normalises `ﬁ` → `fi` and full-width Latin; `"exam-\nple"` joins to `example`; runs of whitespace/newlines collapse to single spaces while paragraph breaks survive; an 800-char limit groups short sentences together; a 2,000-char single sentence is split at commas and every emitted piece is ≤ 800 chars and non-empty; `char_start/char_end` reconstruct each segment's exact substring of the chapter text; Japanese text segments on `。`; an empty chapter yields zero segments rather than an error.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `clean.py`** — `unicodedata.normalize("NFKC")`, de-hyphenate line breaks, collapse `[ \t]+`/`\n{3,}`, strip zero-width and soft-hyphen characters, drop repeated PDF running headers is *not* here (T5a owns it).
- [ ] **Step 4: Implement `segment.py`** — `pysbd.Segmenter(language=base_lang, clean=False)` where `base_lang = language.split("-")[0]` and unknown languages fall back to `en`; greedy packing under `max_chars`; oversize sentence split at `[,;:—]` then spaces then hard slice; track offsets relative to the cleaned chapter text.
- [ ] **Step 5: Verify** — `pytest tests/test_clean.py tests/test_segment.py -v`.
- [ ] **Step 6: Commit** — `feat(ingest): text cleaning and sentence segmentation`.

### Task 6: Project docs

**Files:**
- Create: `README.md`, `docs/CONFIG.md`, `docs/DECISIONS.md`, `docs/BACKUP.md`
- Test: none (documentation), verified by `grep`/`markdownlint` if available.

**Interfaces:**
- Consumes: T1's `.env.example` and `compose.yaml`; the spec's config table.

- [ ] **Step 1: `README.md`** — what Folio is; **local development** (`cp .env.example .env`, `make db`, `make dev-backend`, `make dev-web` in a second terminal, open `http://localhost:5173`); **local testing** (`make test`, `make test-web`, `make e2e` against `compose.test.yaml`, `make fixtures`, how to point at a real LDAP/TTS via `.env` only); **deploy to a server** (`docker compose pull && docker compose up -d`, migrations run on API start, `curl /healthz`, first-admin bootstrap, log inspection, upgrade/rollback by image tag); the nginx `location` block from the spec with `proxy_buffering off` on `/api/v1/events` and `client_max_body_size 200m`.
- [ ] **Step 2: `docs/CONFIG.md`** — every variable, default, required/optional, and a note that LDAP and TTS are only ever reached through env config.
- [ ] **Step 3: `docs/DECISIONS.md`** — seeded with: psycopg 3 + sync SQLAlchemy; in-process login rate limiting (single API worker); `FOLIO_TEST_MODE` test-login endpoint; generated fixture books instead of committing binaries; CI deferred to M6.
- [ ] **Step 4: `docs/BACKUP.md`** — `pg_dump` + `/data` volume restore steps, including audio cache is disposable.
- [ ] **Step 5: Commit** — `docs: README, configuration, decisions, backup`.

---

## Wave 2 — Pipeline and product surface (after Wave 1 merges)

### Task 7: Job queue, worker, storage paths

**Files:**
- Create: `backend/folio/storage.py`, `backend/folio/jobs.py`, `backend/folio/worker.py`, `backend/tests/test_jobs.py`
- Test: `backend/tests/test_jobs.py`

**Interfaces:**
- Consumes: `Settings`, `get_session`, models `Job`, `Book`
- Produces: `book_dir(settings, book_id) -> Path`, `original_path(settings, book_id, ext) -> Path`, `cover_dir(settings, book_id) -> Path`, `audio_path(settings, cache_key, fmt) -> Path`, `ensure_dirs(...)`, `write_original(settings, book_id, suffix, stream) -> tuple[Path, str, int]` (path, sha256, bytes)
- Produces: `enqueue(session, job_type: str, book_id: UUID | None, priority: int = 100) -> Job`; `claim_next(session) -> Job | None`; `finish(session, job, error: str | None = None)`; `notify(session, payload: dict)`
- Produces: `worker.main() -> None` and `python -m folio.worker` entry point; handlers registry `HANDLERS: dict[str, Callable[[Session, Settings, Job], None]]`

- [ ] **Step 1: Write failing tests** — two concurrent sessions claiming jobs never get the same row (run two `claim_next` calls on separate connections; second returns the other job or `None`); priority ordering is respected; a job whose handler raises is marked `failed` with `attempts == 1` and its `error` stored; `enqueue` writes a row with `status="queued"`; `write_original` returns the sha256 of the bytes and writes nothing outside `DATA_DIR` for a book id of `../../etc`-style input (UUID type rejects it).
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `storage.py`** — every path from `settings.data_dir / ...` and UUID/hex values only; `ensure_dirs` creates parent with `0o750`.
- [ ] **Step 4: Implement `jobs.py`** — `claim_next` uses `with_for_update(skip_locked=True)` + `status == "queued"` ordered by `priority, created_at`, sets `status="running", attempts += 1`, commits; `notify` uses `SELECT pg_notify('folio_events', :payload)`.
- [ ] **Step 5: Implement `worker.py`** — loop: claim, dispatch, commit, notify; `SIGTERM`/`SIGINT` stop after the current job; touch `/data/.worker-heartbeat` each iteration; idle sleep 0.5 s.
- [ ] **Step 6: Verify** — `pytest tests/test_jobs.py -v`.
- [ ] **Step 7: Commit** — `feat: job queue, worker loop, storage paths`.

### Task 8: Ingestion pipeline, upload API, SSE

**Files:**
- Create: `backend/folio/ingest/pipeline.py`, `backend/folio/routers/books.py`, `backend/folio/routers/events.py`, `backend/folio/events.py`, `backend/tests/test_pipeline.py`, `backend/tests/test_books_api.py`, `backend/tests/test_events.py`
- Modify: `backend/folio/main.py` (mount routers), `backend/folio/worker.py` (register handler) — *lead merges*
- Test: `backend/tests/test_pipeline.py`, `backend/tests/test_books_api.py`

**Interfaces:**
- Consumes: T5a/T5b extractors + segmenter, T7 queue/storage, T2 auth dependencies
- Produces: `process_book(session, settings, book_id: UUID) -> None` (job handler `"ingest"`)
- Produces endpoints: `POST /api/v1/books` (multipart `files: list[UploadFile]` → `[{book_id, job_id, duplicate_of}]`), `GET /api/v1/books?q=&sort=&status=&page=` → `{items, total, page, page_size}`, `GET /api/v1/books/{id}` → `{book, chapters, progress: null}`, `DELETE /api/v1/books/{id}`, `POST /api/v1/books/{id}/reprocess`, `GET /api/v1/books/{id}/chapters/{chapter_id}/segments`
- Produces: `GET /api/v1/events` SSE, frames `event: job` / `event: book` with JSON data, 15 s keepalive comments

- [ ] **Step 1: Write failing tests** — uploading `epub3` creates one `books` row with `status` `uploading`, one `jobs` row, one `book_files` row with the correct sha256, then `process_book` moves it through `processing` to `ready` with chapters/segments and a non-zero `total_chars`; uploading the same bytes twice returns `duplicate_of` = the first book id and leaves one book; uploading `drm_epub` returns 422 `unsupported_format` with the spec's message and no book; uploading a PDF renamed `.epub` succeeds as a PDF; oversized upload returns 413; `scanned_pdf` ends at `needs_ocr` with chapters but `est_duration_s` and no playable flag; a book whose extraction raises ends `failed` with a readable `error`; `GET /books?q=<title word>` finds it and `sort=title` orders correctly; `GET /books/{id}` includes chapters in order; delete removes rows and the `DATA_DIR` folder; `GET /events` emits an initial `book` frame and a `job` frame when one is enqueued.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `pipeline.py`** — dedupe by sha256 at upload; status transitions `uploading → processing → ready | needs_ocr | failed`; steps store → convert → extract → clean → scanned check → segment → embedded metadata → `total_chars`, `est_duration_s = total_chars / settings.tts_chars_per_second`; idempotent on retry (delete prior chapters/segments first); store the cover bytes at `covers/<book_id>/original.<ext>` and set `cover_key`.
- [ ] **Step 4: Implement `routers/books.py`** — stream each upload to a temp file under `DATA_DIR/tmp` while hashing and enforcing `MAX_UPLOAD_MB`, then `detect_format`, create rows, enqueue; list/search uses the GIN index expression from T1; permissions: delete = admin or uploader, reprocess = admin or uploader; every mutating handler calls `require_csrf`.
- [ ] **Step 5: Implement SSE** — `events.py` runs one `psycopg` `LISTEN folio_events` connection in a daemon thread, pushes payloads into an `asyncio.Queue` via `loop.call_soon_threadsafe`; the route yields the initial snapshot for books/jobs then streams; disconnect unsubscribes. `# ponytail: one global LISTEN connection per API process; shard by book if listener count ever hurts`.
- [ ] **Step 6: Verify** — `pytest tests/test_pipeline.py tests/test_books_api.py tests/test_events.py -v`.
- [ ] **Step 7: Commit** — `feat: ingestion pipeline, upload API, SSE status`.

### Task 9: Frontend upload, library grid, book detail

**Files:**
- Create: `frontend/src/components/{UploadDropzone,BookCard,StatusBadge}.tsx`, `frontend/src/pages/UploadPage.tsx`, `frontend/src/pages/BookDetailPage.tsx`, `frontend/src/api/books.ts`, `frontend/src/hooks/useEvents.ts`
- Modify: `frontend/src/pages/LibraryPage.tsx`, `frontend/src/api/types.ts`, `frontend/src/App.tsx` (routes) — *lead merges `App.tsx`*
- Test: `frontend/src/pages/UploadPage.test.tsx`, `frontend/e2e/upload.spec.ts`

**Interfaces:**
- Consumes: `/api/v1/books`, `/api/v1/books/{id}`, `/api/v1/events`
- Produces: `useBooks(params)` (TanStack Query, infinite/`page`), `useBook(id)`, `useUpload()` (XHR per-file progress), `useEvents()` (`EventSource` → invalidate `["books"]` and `["book", id]`)

- [ ] **Step 1: Write the failing test** — `UploadPage.test.tsx`: dropping two files renders two rows with progress and a status badge; a `job` SSE frame updates the badge from "Processing" to "Ready" without a reload.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Build upload** — drag-and-drop + `<input type="file" multiple accept=".epub,.pdf,.mobi,.azw,.azw3">`, XHR for upload progress, per-file row with status, inline error from the API envelope, click-through to the book on success.
- [ ] **Step 4: Build library** — responsive cover grid 2 cols → 6, skeleton loaders, search/sort/filter controls, status badge, empty state, `Image` with the 200 px cover or the gradient placeholder; "Continue listening" section renders only when `/me/continue` lands in M5 (hide for now).
- [ ] **Step 5: Build book detail** — large cover, title/authors/series/description, language, estimated length, chapter list, status + error, Reprocess button for uploader/admin, disabled Play button with "Metadata and audio arrive in the next milestone" (M4 wires it) — no fake playback.
- [ ] **Step 6: Verify** — `npm run lint && npx tsc --noEmit && npm test -- --run && npm run build`; Playwright `e2e/upload.spec.ts` at 390×844 uploads the EPUB fixture and sees it reach "Ready".
- [ ] **Step 7: Commit** — `feat(web): upload, library grid, book detail`.

### Task 10: End-to-end verification and milestone evidence

**Files:**
- Create: `docs/PROGRESS.md` (append evidence), `frontend/e2e/resume.spec.ts` (placeholder skip until M5 — *do not create fake tests; skip this file*)
- Modify: `docs/MILESTONES.md` (status + evidence links) — *lead owns*

- [ ] **Step 1: Bring up the real stack** — `make up` with `.env` pointing at a local Postgres, a test-mode user, and the mock TTS container; confirm `docker compose ps` healthy.
- [ ] **Step 2: Run the M1 acceptance script** — login as a user in the user group (fake LDAP in test mode) → sees Library, no Admin; login as admin → sees Admin; user outside both groups → refused.
- [ ] **Step 3: Run the M2 acceptance script** — upload each fixture; assert terminal status per fixture (`epub3/epub2/pdf_*/azw3 → ready`, `scanned_pdf → needs_ocr`, `drm_epub → rejected`); upload `epub3` twice → duplicate linked; watch statuses arrive over SSE without reload; time a 500-page EPUB ingest and record it against the 60 s budget.
- [ ] **Step 4: Run the full check suite** — `make lint && make test` (backend) and `npm run lint && npx tsc --noEmit && npm test -- --run && npm run build` (frontend).
- [ ] **Step 4b: Verify both run modes** — `docker compose -f compose.yaml -f compose.test.yaml up -d --build` serves login + upload at `localhost:8000` with the frontend built into the image; then `make down` and confirm `make dev-backend` + `make dev-web` still reach the same API from the Vite dev server with no source mounts in the compose file.
- [ ] **Step 5: Record evidence in `docs/MILESTONES.md`** and commit — `chore: M1–M2 acceptance evidence`.

---

## Parallelization Map

| Wave | Tasks (parallel) | Gate |
| --- | --- | --- |
| 0 | T1 | T1 merged, checks green |
| 1 | T2, T3, T4, T5a, T5b, T6 | all merged, checks green |
| 2 | T7, T8, T9 | all merged, checks green |
| 3 | T10 | acceptance recorded |

Task 2 runs against T3's `conftest.py` contract; T3 merges first. T8's handler registration and `main.py` routing are wired by the lead at merge time to keep `main.py` single-owner. Task 9 may start as soon as T8's endpoint shapes are fixed by this plan (they are pinned above).
