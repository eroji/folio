# Folio — Milestones and Progress

Source of truth: [`folio-application-spec.md`](./folio-application-spec.md).
Execution plan for the current phase: [`superpowers/plans/2026-10-24-m1-m2-foundation.md`](./superpowers/plans/2026-10-24-m1-m2-foundation.md).

Status legend: `todo` · `in progress` · `blocked` · `done (reviews pending)` · `accepted`

| # | Milestone | Status | Acceptance criteria | Evidence |
|---|---|---|---|---|
| 0 | Repo foundation (plan, AGENTS.md, docs, git) | done | Plan approved, `AGENTS.md` in place, first commit landed | `c21d675` |
| 1 | Skeleton and auth | **accepted** | AD user in user group logs in; outsider refused; admin sees Admin menu | 144 backend / 9 web tests + 3 Playwright e2e green; `scripts/acceptance.sh` M1 checks pass |
| 2 | Upload and ingestion | **accepted** | Each fixture reaches its expected status; duplicates detected | All 7 fixtures verified on the compose stack; duplicate, DRM, search, segments verified |
| 3 | Metadata and covers | **accepted** | ISBN EPUB gets the right cover automatically; manual edit survives a re-fetch | 235 backend tests + 23 web tests + 5 Playwright; live Open Library search returns candidates; edit→reprocess verified on the stack |
| 4 | TTS and player | **done (device checks pending)** | Cached playback crosses a chapter boundary with < 1 s gap; lock-screen controls work on iOS Safari + Android Chrome | 311 backend / 51 web tests + 7 Playwright; live synthesis, Range 206, Media Session, voices, cache clear all verified. Real-device gap + lock-screen still manual. |
| 5 | Progress and settings | **accepted** | Phone → desktop resumes within 3 s of the stop point | 344 backend / 84 web / 9 Playwright; live progress round-trip 28.7%, Continue row, settings merge, finished/reset all verified |
| 6 | PWA and polish | **accepted** | Installs to a phone home screen; Lighthouse accessibility ≥ 90 | 394 backend / 133 web / 9 Playwright; Lighthouse **100** on login, library, book and player; offline fallback + cache rules verified |

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

## Milestone 3 — Metadata and covers

**Workstreams:**

| WS | Branch | Task | Deliverable | Depends on |
|---|---|---|---|---|
| K | `feat/covers` | A | Cover validation, storage, 600/200 WebP rendering, upload/URL/serve endpoints with ETag | — |
| L | `feat/metadata-online` | B | Open Library + Google Books providers, similarity/ISBN decision, candidates, pipeline auto-fetch, search/apply endpoints, migration 0003 | K |
| M | `feat/metadata-edit` | C | `PATCH /books/{id}`, validation, `locked_fields` accumulation | A |
| N | `feat/web-metadata` | D | Edit screen, Find metadata panel, review banner, 2:3 canvas crop | contract pinned |

**Acceptance script:** upload an ISBN EPUB → metadata/cover applied automatically; edit title/language → reprocess → edit preserved; replace cover by URL and by cropped upload → 600/200 variants served; rejected URL leaves the old cover; saved candidates surface the review banner.

## Milestone 4 — TTS and player

**Workstreams:**

| WS | Branch | Task | Deliverable | Depends on |
|---|---|---|---|---|
| O | `feat/tts-core` | A | TTS client, voice discovery, cache/synthesis/eviction, text prep, migration 0004 | — |
| P | `feat/tts-api` | B | `segment_audio` queue, prepare/stream/voices/preview endpoints, admin cache clear + TTS health | O |
| Q | `feat/player` | C | Provider, gapless double-audio player, mini player, read-along, Media Session, sleep timer | contract pinned |
| R | `feat/voices-ui` | D | Voice picker, Settings voices + preview, book narrator override, Play/Resume | contract pinned |

**Acceptance:** cached chapter-boundary gap < 1 s; voices list matches the engine; preview plays; seek-ahead shows "Preparing audio…"; Media Session metadata and handlers present; admin health reports `tts: ok`; Range requests work on `/audio/{key}`.

## Milestone 5 — Progress and settings

| WS | Branch | Task | Deliverable | Depends on |
|---|---|---|---|---|
| S | `feat/progress-api` | P | progress table + GET/PUT/DELETE/finished, `/me/continue`, `/me/settings`, percent | — |
| T | `feat/settings-sync` | R | server-backed settings, player reads speed/skips/auto-next/voice | contract pinned |
| U | `feat/progress-ui` | Q | save/resume (3 s rewind), conflict prompt, Continue row, finished/reset | P, R |

**Acceptance:** play → pause → reload resumes within 3 s; two devices prompt when one is > 60 s ahead; Continue row appears/disappears; settings affect the player without a reload.

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
| 2026-10-24 | **T2 merged** (`6941f82`): LDAP (LDAPS + in-chain nested groups), server-side sessions with sliding expiry, HMAC CSRF, 10/15-min lockout, roles, admin list endpoints. Lead fixes: bounded login body, removed committed egg-info from git. |
| 2026-10-24 | **T9 merged** (`7e2f035`): upload page with per-file XHR progress and SSE-driven status, library grid with search/sort/filter/skeletons, book detail, EventSource invalidation. 9 frontend tests green. |
| 2026-10-24 | **M1 complete** (pending browser acceptance in T10). T8 pipeline/API/SSE dispatched. |
| 2026-10-24 | **T8 merged** (`d82de39`): ingest pipeline, upload/list/detail/cover/delete/reprocess/segments API, SSE. Lead fixes: `python-multipart` added to the image lock (the app would not start without it), filename capped to the column width, `job_id` type corrected. |
| 2026-10-24 | **M1 + M2 accepted on the compose stack.** `scripts/acceptance.sh`: role gating, DRM rejection, all 7 fixtures (epub3/epub2/pdf_outline/pdf_flat/azw3 → ready, scanned_pdf → needs_ocr), duplicate linking, search, segments. Playwright at 390×844: empty library after login, inline credential error, upload → Ready without reload. 144 backend tests, 9 web tests, ESLint/tsc/ruff/mypy clean. |
| 2026-10-24 | Lead review fixes during acceptance: LDAP teardown used the nonexistent `Connection.close()` (500 on directory outage, now `unbind()` + `OSError` → generic 401); e2e specs raced on one seeded user (serial workers); `make e2e` now starts from a clean volume; upload e2e asserts the terminal state instead of a sub-second transient. |

| 2026-10-24 | **M3 wave 1 merged:** covers service (`6c8b127`, 34 tests: magic bytes, 2:3 WebP 600/200, ETag/304, URL limits), `PATCH /books/{id}` with `locked_fields` (`c47fcb7`), and the edit UI / Find metadata / canvas 2:3 crop (`9675f2b`, 23 tests). Lead fixes: deleted the dead M2 cover handler so one router owns the route; hardened the edit→reprocess e2e (CSRF header, duplicate-upload rows, unique title). |
| 2026-10-24 | **LDAP improved from the working `notely` integration**: `DOMAIN\user` / `user@domain` normalization, `{upn}` filters from the base DN, canonical `sAMAccountName`, exactly-one-result, empty-password guard, `get_info=None`, no referral chasing. |
| 2026-10-24 | **TTS backend verified** (`docs/TTS.md`): Qwen3 Voice Studio at `vllm.dotslash.io:8880`, voices endpoint shape, Opus/Ogg output, `model=tts`. Ready for M4. |
| 2026-10-24 | Online metadata providers (Task B) dispatched: Open Library + Google Books, similarity/ISBN decision, candidates, pipeline auto-fetch, migration 0003. |
| 2026-10-24 | **T-B merged** (`d989d18` + lead fix `a6658d9`): Open Library + Google Books (429-safe), ISBN/0.9 matching, candidates + migration 0003, pipeline auto-fetch. Lead fixes: apply-field whitelist (a client could send `fields:["id"]`), explicit applies now lock their fields while staying re-appliable. |
| 2026-10-24 | **M3 accepted on the compose stack.** `scripts/acceptance.sh`: edit → reprocess preserves the title; cover upload produces 200/600 WebP; a rejected cover URL leaves the cover intact; live Open Library search returns a candidate. Playwright 5/5 at 390×844, including the test-mode sign-in panel added for local use. 235 backend / 23 web tests green. |

| 2026-10-24 | **M4 wave 1 merged:** TTS core (`080b436`): client with 1/4/16 s retries and opus→mp3 fallback, live voice discovery (five engine voices verified), cache keys shared across speeds, LRU eviction that skips busy/recent files, voice selection incl. `zh-TW`→`zh`, migration 0004. Player (`merged`): two-element gapless handoff, chapter auto-advance, Media Session, sleep timer, mini player. Voices UI: per-language picker with preview, narrator override, Settings page, Play/Resume. |
| 2026-10-24 | **Read-along upgraded per product request:** full chapter rendered, spoken position mapped to a character offset, active sentence + paragraph highlighted, throttled center auto-scroll (manual scroll pauses 5 s, reduced-motion aware), tap-to-seek; tested. |
| 2026-10-24 | Audio API/queue (Task B) dispatched: `segment_audio` SKIP LOCKED queue, prepare/stream(Range)/retry, voices + preview, admin cache clear and a real TTS health probe. |
| 2026-10-24 | **T-B merged** (`6fb6e3f`): prepare/stream/retry, voices + preview, admin cache clear, real TTS health (`tts: ok`), worker claims TTS before ingest. Live smoke: 3 segments ready in ~6 s, 39.8 s Opus, `Range` → 206 with `Content-Range`. |
| 2026-10-24 | **M4 accepted (device checks pending).** Found and fixed a self-amplifying SSE loop: `prepare` notified on every idempotent call, each `audio` frame re-triggered `prepare` in the player and flooded the browser (`ERR_INSUFFICIENT_RESOURCES`). Fix: notify only on real status transitions + a single in-flight prepare + frame filtering. Added a regression test. Playwright 7/7; acceptance covers voices/preview/prepare/Range/cache-clear/health; Media Session metadata and handlers verified in Chromium. |

| 2026-10-24 | **M5 settings merged** (`bad43de`): `/me/settings`-backed listening preferences with optimistic coalesced saves and a localStorage fallback; the player now uses the saved speed, skip intervals, auto-play-next and per-language voice without a reload. 59 web tests. |
| 2026-10-24 | Progress API (P) and progress UI (Q) in flight: progress table + endpoints, save/resume with 3 s rewind, cross-device prompt, Continue listening, finished/reset. |
| 2026-10-24 | **M5 accepted.** Progress table + API (`63f2c82`), server-backed settings (`bad43de`), player save/resume with 3 s rewind, Continue listening row, finished/reset (`717ea27`). Playwright 9/9 including resume-after-reload and settings persistence; acceptance: 28.7% round-trip, Continue lists the book, 1.25× + skip 10 + auto-next false merge correctly, finished removes it, reset clears it. |
| 2026-10-24 | Cross-device resume relies on the shared DB; the ">60 s ahead on another device" prompt is unit-tested with two labels but not yet exercised with two real browsers side by side. |

| 2026-10-24 | **Demo-feedback round (8 findings).** Playback: only one audio element can play; `pause()` stops both; handoff happens only on `ended` — with regression tests. Mini player now exists on desktop (it was `md:hidden`). Metadata: search results are scored against the book (0 % → real %; a matching book showed 100 %), applying a candidate fills the cover when the book has none. Korean/Japanese/Chinese previews use pure-script sample text (the engine returns different audio for `ashley-kr` vs `ashley-en`; human ear still required). Chapters can be excluded from playback by admins/uploaders (`excluded` flag, migration 0006), hidden under an "Excluded chapters" disclosure, skipped by prepare/progress. Reader UX: fixed bottom Play/Resume bar, collapsible chapter list, read-along default-open with 68ch measure / clamp type / A−A+, explicit Sleep-timer menu, desktop player widened to `max-w-3xl`, skip buttons show 15/30. |
| 2026-10-24 | Test-harness trap documented: `create_all` never adds columns, so a migration leaves `folio_test` stale and 62 tests fail; `make reset-test-db` added. |

### UX iteration 2 (demo follow-up)

| WS | Branch | Task | Deliverable |
|---|---|---|---|
| V | `feat/pronunciation` | A | per-book pronunciation rules (migration 0007), applied to TTS text/cache; tts voice hidden; first-for-language fallback |
| W | `feat/reader-book` | B | page-like reader with internal scrollbar + serif, chapter select + arrows, Plex-style mini player, `stop()` |
| X | `feat/book-settings` | C | cover play/percent overlay, book settings with chapters + pronunciation table, reset confirmation |
| Y | `feat/voices-cleanup` | D | language-only voice picker, no Default/Show-all, no `tts` |

**Status:** **done and accepted 2026-10-25.** Reader is a serif page with its own scrollbar; chapter `<select>` + prev/next arrows; Plex-style mini player (cover percent badge, elapsed/total, prev/back/play/forward/next/stop, speed on desktop); book settings holds chapter inclusion and the pronunciation table; reset asks for confirmation and restarts at chapter 1; voices are language-only with no Default/Show-all and no `tts`. 378 backend / 114 web / 9 Playwright tests; acceptance includes pronunciation CRUD + tts-hidden.

**Fixes found during acceptance:** the player loaded *all* chapters (including excluded ones) and landed on an excluded first chapter → "Chapter not found"; it now filters excluded chapters at load. Chapter numbering differs between surfaces (player shows original `idx+1`, book page numbers the included list) — cosmetic, align in a later pass.

**Follow-up from the third demo:** the player is now a fixed-height column — header/controls never scroll and only the reader panel scrolls internally, so it can no longer slide over the chapter select or scrubber. Pause→resume could hang on "Preparing audio…" because `play()` only pumped and waited for a poll when the current segment was not ready; resume now issues a prepare immediately, `prepareAudio` has a 20 s timeout (a hung request can no longer block the single in-flight slot), and the tab becoming visible again wakes the poll. Regression test added.

## Milestone 6 — PWA and polish

| WS | Branch | Task | Deliverable |
|---|---|---|---|
| Z | `feat/m6-backend` | A | Prometheus `/metrics`, admin job retry + cache stats, finished shelf, `sort=progress`, `can_edit` |
| AA | `feat/m6-web` | B | Service worker + offline page, admin tools, Finished shelf, uploader permissions, numbering |

**Acceptance:** installable shell with offline page and cached covers (never audio); Lighthouse accessibility ≥ 90; admin retry works; Finished shelf + progress sort; uploaders see their own book's settings.

**Status: accepted 2026-10-25.** Service worker caches shell + covers and never `/api/v1/audio` (verified in Cache Storage after playback); offline navigation falls back to a branded page. Admin retry/cache stats/TTS latency, Finished shelf, `sort=progress`, and `can_edit` all live. Lighthouse accessibility: **login 100 · library 100 · book 100 · player 100** (after fixing low-contrast `<summary>` text and three icon-button name mismatches). Metrics at `/metrics` expose templated paths only (no IDs).

## UI redesign — Direction C "Companion" (post-M6)

Handoff: `docs/ui-handoff/HANDOFF.md` + `reference/*.html` + drop-in tokens. Implemented in six phases, each reviewed before the next.

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundations: tokens (with temporary aliases), Plus Jakarta Sans + Newsreader, theme resolution, Material Symbols `<Icon>` pipeline | **done** — 135 web tests, self-hosted fonts, theme hook tested |
| 2 | Desktop icon rail + account menu; phone header/tab bar; remove old top nav | **done** — 144 web tests; rail/menu/tabs verified at 1440 and 390 |
| 3 | Now Playing panel (desktop) + sheet (phone) bound to the single player; collapse/expand, focus mode | **done** — 153 web tests; 50/50 panel, collapsed bar, sheet verified at 1440/390; focus reuses the full player |
| 4 | Book page: hero, progress badge, primary-action states, ⋯ menu + toast, Chapters/About/Manage tabs | **done** — 157 web tests; hero/tabs/manage verified at 1440 and 390 |
| 5 | Restyle undesigned screens with the new tokens/components (structure unchanged) | **done** — 167 web tests; Library/Search, Upload/Login, Settings/Admin/Edit/Player |
| 6 | Remove lucide, unused styles; update DESIGN.md and DECISIONS.md | **done** — lucide/Inter/Outfit removed, alias layer deleted, DESIGN.md rewritten |

**Post-acceptance fixes (2026-10-25) — done and verified:** focus mode rebuilt to the reference (paper surface, contents, 680px Newsreader page, transport card, F/C/Esc/Space); Manage shows **15** chapter rows before "Show all"; toggling inclusion now optimistically updates the Chapters tab and count and renumbers 1..N; the stray Find metadata search box rendered outside Manage was removed (the review banner switches to Manage). 180 web tests, 9 Playwright, acceptance all-pass.

**Status: complete 2026-10-25.** All six phases shipped. 167 web tests, 9 Playwright, acceptance all-pass, Lighthouse accessibility **100** on login/library/book/player with no failing audits. Reference screenshots: `docs/screenshots/redesign-*.png`.

**Notes:** the reference HTML uses `data-theme` on `<html>`; the app now resolves System at runtime. Filled icon variants are not shipped in `@material-symbols/svg-400` (rounded/outlined only) — play/pause/skip are visually filled already. Lighthouse runs must be done outside the repo (an earlier run dumped a Chrome profile into it; ignored now).

### Redesign follow-up 2 (2026-10-25)

- Excluded chapters hidden from the Chapters tab; **Preparing…** state + row spinner while audio generates.
- Cover badge/Continue row refreshed after progress saves.
- Narrator voice is a popover (language voices, display names); removed from panel/focus mode.
- Voice display names persisted in `app_settings` and renameable in Admin (`ashley-en` → Ashley).
- Read-along rAF smoothing; all icons +10 %.
- Updated handoff package applied: **brand refresh** (new mark, wordmarks, favicons/PWA icons/manifest) and the fully designed **Settings** page (720px cards, segmented theme, sec inputs, switches, aligned voice rows with play/stop preview, save-on-change).
- Voice display names persisted and renameable in Admin; `ashley-en` renders as **Ashley** (no collision suffix — each voice row is already language-scoped).
- Remaining duplicate voice controls removed from the phone full player too.
- Final counts: 415 backend / 195 web / 9 Playwright; Lighthouse 100 on settings as well.
- Completion percent now recomputes for every saved progress row when a chapter is excluded/re-included, so hidden chapters are not counted.
- Player secondary icons (speed, sleep) use the same size as the rest of the transport row.
- Settings expands to the full page area when the player is closed/collapsed and follows the 50/50 split when the panel is open (deviation from the handoff's fixed 720px, requested in testing).

## UI redesign — Direction D "Ribbon" (replaces Direction C)

Handoff: `docs/ui-handoff/HANDOFF.md` (the old `folio-ui-handoff` is superseded). Dark-only, amber accent, labelled sidebar, bottom player bar + expanded `/player`, Home `/`, Library `/library`, Search `/search`, book two-column layout, Genre field.

| Phase | Scope | Status |
|---|---|---|
| 1 | Tokens, Sora/Figtree, remove theme, lucide, brand | **done** — dark-only, 193 web tests, new brand |
| 2 | Shell: sidebar, top bar, account menu, phone nav, routes | **done** — 200 web tests, routes `/`, `/library`, `/search` |
| 3 | Player bar, expanded player, phone player/read-along | **done** — 197 web tests, panel/focus removed |
| 4 | Book page two-column, ⋮ menu + narrator dialog | in progress |
| 5 | Home/Library shelves, Genre data, group API | backend + frontend in progress |
| 6 | Search, Upload, Settings, Sign in | planned |
| 7 | Restyle remaining, clean up, rewrite DESIGN.md | planned |

Backend §5 merged: genre + cover colour (migration 0009), grouped books, `/me/home`, `/search`; 455 backend tests.

## Known gaps carried into M3+

- **`sort=progress`** falls back to recent until M5 adds the progress table.
- **Online metadata is best-effort**: Google Books rate-limits to HTTP 429 without `GOOGLE_BOOKS_API_KEY`, so Open Library is the effective primary source. Provider failures are logged and skipped, never fail ingestion.
- **ISBN auto-apply** is proven deterministically with mocked providers; the live check exercises search, not an ISBN-bearing fixture. A real ISBN EPUB will auto-apply in normal use.
- **Applied metadata locks its fields** (by design), so a later "Find metadata" apply of the same field is an explicit override — the UI's apply path honours that; automatic fetches do not.
- **M4 device checks**: the "< 1 s cached gap" and lock-screen controls on iOS Safari / Android Chrome are not machine-verifiable here. The two-element handoff, chapter auto-advance and Media Session metadata/handlers are covered by tests and a Chromium check; the phone check is manual.
- **TTS concurrency is 1 per worker process** (the spec's `TTS_CONCURRENCY=2` is a ceiling). Two worker containers would exceed it — add a DB/Redis semaphore before scaling out.
- **Crash recovery**: a row left `generating` by a killed worker stays claimed; a startup sweep should reset stale `generating` rows (not implemented).
- **Chapter title lead-ins** are not synthesized (optional `lead_in` in the prepare contract); the player speaks segment text only, and the `speak_titles` setting is stored but inert.
- **Finished books** have a badge and leave Continue listening, but there is no "Finished" shelf because no endpoint lists finished books yet (M6).
- **Cross-device prompt**: the > 60 s rule is tested at unit level with two device labels; a two-browser manual check is still worthwhile.
- **PWA install prompt** is not customised; installation uses the browser's own affordance. A real phone install + offline test is still manual.
- **Service-worker version** (`folio-v1`) is bumped by hand when the shell changes; automate with a build hash if it becomes easy to forget.
- **Per-book cache clear** is API-only (`book_id` supported); the admin UI clears everything.
- **Docs**: `BACKUP.md` still needs a restore rehearsal against a real dump.
- **Uploader-only actions in the UI**: the API enforces "admin or uploader", but the book payload deliberately hides `uploaded_by`, so the UI shows Reprocess/Delete to admins only. Revisit in M5 with a `can_edit` flag.
- **LDAP outage → generic 401**: transport failures are indistinguishable from bad passwords by design (no directory-internals leak). Operators see `reason=ldap_error` in logs.
- **500-page ingest budget (< 60 s)** is not measured: fixtures are small. Measure with a real book before the performance sign-off in M6.
- **Single-process login rate limiter**: correct for one uvicorn worker (the compose default); would need a DB-backed limiter if the API is scaled out.
