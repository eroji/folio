# Folio — Milestones and Progress

Source of truth: [`folio-application-spec.md`](./folio-application-spec.md).
Execution plan for the current phase: [`superpowers/plans/2026-10-24-m1-m2-foundation.md`](./superpowers/plans/2026-10-24-m1-m2-foundation.md).

Status legend: `todo` · `in progress` · `blocked` · `done (reviews pending)` · `accepted`

| # | Milestone | Status | Acceptance criteria | Evidence |
|---|---|---|---|---|
| 0 | Repo foundation (plan, AGENTS.md, docs, git) | done | Plan approved, `AGENTS.md` in place, first commit landed | `c21d675` |
| 1 | Skeleton and auth | in progress | AD user in user group logs in; outsider refused; admin sees Admin menu | T1 + T4 merged; T2 running; 67 backend / 3 web tests green |
| 2 | Upload and ingestion | in progress | Each fixture reaches its expected status; duplicates detected | T5a + T5b merged; queue/API/UI remaining |
| 3 | Metadata and covers | todo | ISBN EPUB gets the right cover automatically; manual edit survives a re-fetch | — |
| 4 | TTS and player | todo | Cached playback crosses a chapter boundary with < 1 s gap; lock-screen controls work on iOS Safari + Android Chrome | — |
| 5 | Progress and settings | todo | Phone → desktop resumes within 3 s of the stop point | — |
| 6 | PWA and polish | todo | Installs to a phone home screen; Lighthouse accessibility ≥ 90 | — |

## Phase 1 scope (this session)

Milestones 1 and 2 only. Metadata (M3), TTS/player (M4), progress/settings (M5), and PWA polish (M6) are planned but not executed until M1–M2 are accepted.

## Milestone 1 — Skeleton and auth

**Workstreams** (git worktree + branch per workstream, one worker each):

| WS | Branch | Task | Deliverable | Depends on |
|---|---|---|---|---|
| A | `feat/foundation` | T1 | Compose stack, settings, schema + migrations, health, packaging | — |
| B | `feat/auth` | T2 | LDAP login/logout/me, sessions, CSRF, roles, admin list | A, C (conftest) |
| C | `test/harness` | T3 | pytest harness, fixture books, mock TTS, test-mode login | A |
| D | `feat/web-shell` | T4 | Vite/TS/Tailwind shell, brand tokens, icons, login page | A |
| E | `docs/project` | T6 | README, CONFIG, DECISIONS, BACKUP | A |

**Acceptance script (run on a 390 × 844 viewport):**
1. User in `FOLIO_LDAP_USER_GROUP` signs in → Library, no Admin menu.
2. User in `FOLIO_LDAP_ADMIN_GROUP` signs in → Admin menu visible, `/admin/jobs` reachable.
3. User in neither group → "Your account is not allowed to use Folio".
4. Wrong password → "Invalid username or password"; 11 attempts → lockout.
5. CSRF-less POST rejected; session cookie is HttpOnly/Secure/SameSite=Lax.

## Milestone 2 — Upload and ingestion

**Workstreams:**

| WS | Branch | Task | Deliverable | Depends on |
|---|---|---|---|---|
| F | `feat/ingest-extract` | T5a | Magic-byte detection, EPUB/PDF/Kindle extraction | A, C |
| G | `feat/ingest-text` | T5b | Cleaning + sentence segmentation | A, C |
| H | `feat/queue` | T7 | `jobs` queue (SKIP LOCKED), worker loop, storage paths | A |
| I | `feat/ingest-api` | T8 | Pipeline orchestrator, upload/list/delete API, SSE | F, G, H |
| J | `feat/web-ingest` | T9 | Upload page, library grid, book detail | D, I (contract pinned) |

**Fixture expectations:**

| Fixture | Expected terminal status |
|---|---|
| `epub3` | `ready` |
| `epub2` | `ready` |
| `pdf_outline` | `ready` |
| `pdf_flat` | `ready` |
| `azw3` | `ready` (skipped when Calibre absent) |
| `scanned_pdf` | `needs_ocr` |
| `drm_epub` | rejected, `unsupported_format` |

**Acceptance script:** upload all seven fixtures; assert terminal statuses; upload `epub3` twice → second response carries `duplicate_of`; statuses update live over SSE without a reload; `GET /books?q=` finds an ingested title.

## Remaining milestones (planned, not yet detailed)

| # | Workstreams | Key risks |
|---|---|---|
| 3 | embedded + Open Library + Google Books metadata, candidate matching, edit form, cover pipeline + 2:3 crop | fuzzy matching threshold 0.9; `locked_fields` must survive re-fetch; cover hashing/cache headers |
| 4 | TTS client + cache + eviction, lookahead queue and priorities, full/mini player, read-along, Media Session | gapless double-`<audio>` buffer; opus fallback to mp3; shared GPU concurrency cap |
| 5 | progress save/resume, cross-device prompt, continue-listening row, per-language voices + preview | 10 s save cadence + `sendBeacon`; last-write-wins with 60 s ahead prompt |
| 6 | manifest/SW/offline, admin tools, metrics, accessibility, README/BACKUP/DECISIONS completion | Lighthouse ≥ 90; SW must not cache audio |

## Progress log

| Date | Event |
|---|---|
| 2026-10-24 | Spec read; decisions taken: M1–M2 scope, mocked integrations, worktree-per-workstream. Plan and AGENTS.md drafted. |
| 2026-10-24 | **T1 merged** (`c21d675`): schema + migrations 0001/0002, config, health, compose/Dockerfile, Makefile. Lead review fixes: tags added to the FTS index, editable install repaired, `DATA_DIR` split between local dev and compose, SPA history fallback. 17 tests, ruff, mypy green. |
| 2026-10-24 | Wave 1 dispatched: T3 harness, T4 web shell, T5a extractors, T5b text pipeline, T6 docs (5 parallel worktrees). |
| 2026-10-24 | **T6 merged** (`ec7d50d`): README (local dev/test/deploy), CONFIG, BACKUP, DECISIONS. Lead fixes: roadmap tables, `FOLIO_IMAGE` pull path. |
| 2026-10-24 | **T5b merged** (`1ee16c9`): cleaning + sentence segmentation, 20 tests. Verified no-text-loss/offset/limit invariant independently. |
| 2026-10-24 | **T3 merged** (`b7867aa`): harness, 7 fixture books, mock TTS, test-mode login. Lead fixes: pytest config consolidated into `pyproject.toml`, warning when test mode mounts. |
| 2026-10-24 | **T5a merged** (`0d49af3`): magic-byte detection + EPUB/PDF/Kindle extraction. Lead fixes: `ScannedPDF` carries metadata/cover for `needs_ocr`; cover limited to page 1. Cross-branch extract→clean→segment run on 3 fixtures OK. |
| 2026-10-24 | **T4 merged** (`99b98a7`): React 19/Vite 8/Tailwind 4 shell, brand tokens, login, admin placeholder, icons/manifest. Lead fix: generated SPA output untracked instead of a `.gitkeep`-restoring build plugin. Full checks green on `master`. |
| 2026-10-24 | **T7 merged** (`ab06131`): Postgres job queue (SKIP LOCKED), worker loop with heartbeat + graceful SIGTERM, id-validated storage paths. Lead fix: harness TRUNCATE hang (dispose pool + 5 s `lock_timeout`) — 5 consecutive green runs; unknown API paths now return the JSON 404 envelope instead of 405. |
| 2026-10-24 | Wave 2: T2 auth and T9 upload/library UI in flight; T8 (pipeline/API/SSE) queued behind auth. Verified the built OCI image serves the SPA, deep links and `/healthz` on the compose stack. |
