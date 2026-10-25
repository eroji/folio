# Folio M5 (Progress and Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Save listening position per user per book, resume on any device within 3 seconds of the stop point, show Continue listening, and sync listening settings (speed, per-language voices, skip intervals, auto-play, chapter titles).

**Architecture:** One `progress` row per `(user, book)` written by `PUT /books/{id}/progress`; the player saves every 10 s and on pause/chapter change/hide, resumes with a 3 s rewind, and asks the server for a fresher position from another device. `users.settings` JSONB stores listening preferences behind `GET/PUT /me/settings`.

**Spec:** `docs/folio-application-spec.md` (Player and progress tracking → Progress model, Per-user listening settings; Endpoints; Screens 2, 4, 8; Milestone 5)

## Global Constraints

- M1–M4 guarantees hold (session, CSRF, envelope, IDs, 44 px, Lucide, no emoji).
- Last write wins by `updated_at`. Never create two progress rows for one user+book.
- Saving must never interrupt playback: a failed save is silent (retry next tick), never an error banner.
- `sendBeacon` cannot set the CSRF header — use `fetch(..., { keepalive: true })` with the header; record this deviation.
- Percent is character-based, computed server-side from `total_chars` and the segment's `char_start`/`char_end`; never from file duration.
- Progress and settings are strictly per user; one user must never see another's position.
- Auto-play next chapter defaults **on**; speak-chapter-titles defaults **on** in settings storage (synthesis of title lead-ins stays deferred).

## Review Focus

1. **Play → pause → reload** → resumes within 3 s of the stop point (T-Q).
2. **Second device ahead** → prompt with device label and position, not silent overwrite (T-Q).
3. **Progress save while offline** → playback continues, next tick retries (T-Q).
4. **Another user's book progress** → 403/404, never a leak (T-P).
5. **Skip intervals / speed changed in Settings** → the player uses them on the next interaction without a reload (T-R).

---

## Wave 1 — Backend (P) and settings UI (R), in parallel

### Task P: Progress + settings API (migration 0005)

**Files:** `backend/folio/models/progress.py`, `backend/folio/models/__init__.py`, `backend/alembic/versions/0005_progress.py`, `backend/folio/routers/progress.py`, `backend/folio/routers/me.py`, `backend/folio/routers/books.py` (include progress in detail), `backend/folio/main.py` (mounts), `backend/tests/test_progress_api.py`, `backend/tests/test_me_api.py`.

**Data:** `progress(user_id FK, book_id FK, chapter_id FK, segment_id FK, offset_s float, percent float, device_label text, updated_at, finished_at, PK(user_id, book_id))`.

**Endpoints:**
- `GET /books/{id}/progress` → `{progress: {chapter_id, segment_id, offset_s, percent, device_label, updated_at, finished_at} | null}`
- `PUT /books/{id}/progress` body `{chapter_id, segment_id, offset_s, device_label}` → upsert, recompute percent, return `{progress, ahead_of_other_device: bool}` where ahead means the stored row (from another device) was more than 60 s ahead of the incoming position; only the caller's own row is read.
- `DELETE /books/{id}/progress` → reset (204).
- `PUT /books/{id}/progress/finished` body `{finished: bool}` → set/clear `finished_at`.
- `GET /me/continue?limit=10` → in-progress, unfinished, most recent first: `{items: [{book: BookPublic, progress}]}`.
- `GET /me/settings` / `PUT /me/settings` → JSONB merge of `{speed, voices, skip_back, skip_forward, auto_next, speak_titles}` with validation (speed 0.75–2.5, skips 5–120 s, voices map of language → voice id).
- `GET /books/{id}` now returns the caller's `progress` and `progress.percent`.

All routes session-scoped; mutations CSRF; `GET/PUT progress` restricted to the caller (every user may read/write their own row for any book they can see).

**Tests:** upsert idempotency; two users isolated; percent math incl. last chapter; finished toggling and Continue excludes finished; ahead-of-other-device flag at 59/61 s; delete; settings validation and merge; unauth 401; CSRF 403; migration up/down.

### Task R: Settings sync + player preferences (frontend)

**Files:** `frontend/src/api/settings.ts`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/player/PlayerProvider.tsx` (read settings only), `frontend/src/hooks/useListeningSettings.ts`, tests.

**Contract:** `GET /me/settings` → `{settings: {speed, voices, skip_back, skip_forward, auto_next, speak_titles}}`; `PUT /me/settings` body partial → `{settings}`.

**Behavior:** replace the localStorage-only settings with TanStack Query + mutation (optimistic, fall back to localStorage offline, hydrate from the server on load); Settings page edits default speed, per-language voices, skip intervals, auto-play, speak titles; the player reads `speed` at start and `skip_back`/`skip_forward` in the 15/30 buttons, `auto_next` before chapter advance, and applies a saved per-language voice when preparing audio. Voice previews and the picker stay as they are.

**Tests:** server settings hydrate; save debounced/optimistic; localStorage fallback; player uses speed + skip intervals + auto_next; settings page round-trip.

## Wave 2 — Progress UI (Q), after P and R merge

### Task Q: Save/resume, conflict prompt, Continue listening, finished

**Files:** `frontend/src/api/progress.ts`, `frontend/src/player/PlayerProvider.tsx`, `frontend/src/pages/LibraryPage.tsx`, `frontend/src/pages/BookDetailPage.tsx`, `frontend/src/components/ResumePrompt.tsx`, tests, `e2e/progress.spec.ts`.

**Behavior:**
- On open, fetch progress; if present, start at that segment with a **3 s rewind** (never below 0).
- Save every 10 s while playing, on pause, chapter change, and on `visibilitychange`/`pagehide` via `fetch keepalive`; include the device label (stable per browser, e.g. `navigator.platform` + short random id); failures are silent.
- If the server position is from a different device and more than 60 s ahead of where this device was about to resume, show "Continue from <chapter, time> on <device>?" with Continue / Start here.
- Library: "Continue listening" row (cover, title, progress bar, time left) above the catalog, hidden when empty.
- Book page: progress bar + Play/Resume resumes; "Mark finished" / "Reset progress" actions.
- Last segment ends → save `finished: true`; finished books leave Continue and show a Finished badge.
- Update `e2e/player.spec.ts` if needed; new `e2e/progress.spec.ts`: play ~5 s, pause, reload, resume at ≥ the stop point minus 3 s.

## Acceptance

- `make test`, `make lint`, frontend tests/build, Playwright 390×844.
- Stack: play → pause → reload resumes within 3 s; two contexts (two browser contexts with different user agents) show the ahead prompt; Continue listening appears and disappears when finished; settings change alters speed/skips without reload.
- Extend `scripts/acceptance.sh`: PUT/GET progress round-trip, percent > 0, Continue lists the book, DELETE resets, settings PUT/GET merge.
