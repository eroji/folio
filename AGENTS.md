# AGENTS.md — Folio

Folio is a self-hosted, mobile-first web app that turns EPUB/PDF/Kindle uploads into a shared audiobook catalog. Backend: FastAPI + PostgreSQL + a Python worker. Frontend: React + Vite + TypeScript + Tailwind PWA. Read `docs/folio-application-spec.md` before changing behavior; it is the source of truth. Read `docs/MILESTONES.md` for current scope and `docs/superpowers/plans/` for the active task list.

## Repository layout

```
backend/folio/          FastAPI app, worker, ingest pipeline
backend/alembic/        migrations (linear chain, one revision per milestone)
backend/tests/          pytest tests + generated fixtures
backend/scripts/        make_fixtures.py
frontend/src/           React app (api/, auth/, components/, pages/, styles/)
frontend/e2e/           Playwright smoke tests
docs/                   spec, milestones, decisions, backup, config, plans
```

## Commands

```bash
# Backend
cd backend && python -m pytest tests/ -v
cd backend && ruff check . && ruff format --check . && mypy folio
cd backend && alembic upgrade head

# Frontend
cd frontend && npm run lint && npx tsc --noEmit
cd frontend && npm test -- --run
cd frontend && npm run build

# Fixtures and stack
make fixtures            # regenerate the seven test books
make up / make down      # compose stack
```

Tests need PostgreSQL: set `TEST_DATABASE_URL` (default `postgresql+psycopg://folio:folio@localhost:5432/folio_test`). Never point tests at the development or production database.

## Working agreement

- **TDD.** Write the failing test, prove it fails, implement, prove it passes, commit. No implementation task is done without a test that would fail if the logic broke.
- **Small commits.** One logical change per commit, `type: imperative summary` (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- **One workstream per branch/worktree.** Do not edit files owned by another workstream (each task lists its files). If you need a change outside your files, report it instead of making it.
- **Run your checks before claiming done.** Paste the command and its result. "Should work" is not done.
- **Stay in scope.** Implement the current milestone only. No speculative abstractions, no config knobs nobody sets, no dependency for what the stdlib or an installed package already does.
- **Record decisions** that the spec leaves open in `docs/DECISIONS.md` (one line: decision, why, what it costs).

## Backend conventions

- Python 3.12, full type hints, `ruff` + `mypy` clean. SQLAlchemy 2.x typed models (`Mapped[...]`, `mapped_column`), Pydantic v2 schemas, sync sessions.
- Routers are thin: validate → call a service/pipeline function → return a schema. Business logic lives in `folio/ingest/`, `folio/jobs.py`, `folio/security.py`.
- API errors go through `ApiError(code, message, status)`; the response body is always `{"error": {"code": "...", "message": "..."}}`. Never leak stack traces or LDAP responses.
- Every state-changing endpoint requires `require_csrf`. Every route except `auth.login` and `healthz` requires a session.
- File paths are built from UUIDs and hex cache keys under `DATA_DIR` — never from an uploaded filename. Type comes from magic bytes.
- Tests use the fixtures in `backend/tests/conftest.py`; integrations (LDAP, TTS) are faked or pointed at the mock server. No test may reach the internet or a real homelab service.
- Non-trivial logic (a branch, a loop, a parser, a money/security path) leaves one runnable check behind: a pytest test.

## Frontend conventions

- TypeScript strict, ESLint clean, function components + hooks, TanStack Query for server state. No global state library.
- Brand values live only in `src/styles/tokens.css`; components use tokens/Tailwind mappings, never raw hex. Light and dark both work; default follows `prefers-color-scheme`.
- Mobile-first at 390 px; 44 × 44 px minimum touch targets; respect `env(safe-area-inset-*)`; Lucide icons at 1.75 px stroke; no emoji.
- Every list has an empty state, every async view a skeleton. Icon-only buttons need an `aria-label`.
- The API client is the only place that calls `fetch`; it attaches `X-CSRF-Token` from the `folio_csrf` cookie.
- No component library. Tailwind + tokens + clsx only.

## Security rules (never simplify these away)

- Paths from IDs, not user input. Sanitize any HTML rendered from book metadata (`bleach` server-side).
- Passwords, bind attempts, and full LDAP responses never enter logs.
- Sessions are DB rows; cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day sliding expiry.
- Uploads are size-limited by `MAX_UPLOAD_MB`, streamed to disk, and type-checked by magic bytes.
- Containers run as non-root; no secret is committed.

## Definition of done (per task)

1. Tests written first and passing; the full suite still passes.
2. `ruff`, `mypy`, `eslint`, `tsc --noEmit` clean for the touched side.
3. No TODOs left in shipped code without a `ponytail:`/`TODO(milestone)` note naming the ceiling.
4. Behavior matches the spec's exact user-facing copy and the pinned interfaces in the plan.
5. Committed on the workstream branch with the checks' output in your report.

## Out of scope

DRM removal, OCR, hosting a TTS model, native apps, public sign-up, multi-tenancy, Redis, Web Audio graphs, component libraries, ORMs with async sessions. If the spec lists it under M3–M6, do not build it now.

## Reporting back

End with: files changed, tests/checks run with results, anything you deliberately deferred and why, and any interface you had to invent that the plan did not pin.
