# Folio M6 (PWA and Polish) Plan

**Goal:** Installable offline-capable PWA, complete admin tools, Prometheus metrics, an accessibility pass, the Finished shelf / progress sort, and correct uploader permissions in the UI.

**Spec:** `docs/folio-application-spec.md` (PWA, Admin, Observability, Milestone 6).

## Constraints

- Service worker caches the app shell and cover images only — **never audio**.
- No secret in logs; metrics must not carry usernames or book titles.
- Lighthouse accessibility ≥ 90, verified with a real run, not assumed.
- Existing test/acceptance guarantees hold; all new endpoints require session/CSRF as appropriate.

## Workstreams

### A. Backend (`feat/m6-backend`)
1. **Metrics** — add `prometheus-client`; `/metrics` (unauthenticated, internal network). Counters/histograms: `folio_http_requests_total{method,path,status}` (path templated, no IDs), `folio_tts_requests_total{result}`, `folio_tts_request_seconds`, `folio_tts_failures_total`; gauges: `folio_jobs{status}`, `folio_audio_cache_bytes`, `folio_sse_listeners`. Instrument the TTS client and SSE endpoint. Tests: text exposition contains the names; no IDs/titles.
2. **Admin** — `POST /admin/jobs/{id}/retry` (failed/done → queued, 202), `GET /admin/cache` → `{files, bytes, tts: {status, latency_ms}}`, keep `POST /admin/cache/clear` (extend `book_id` filtering), keep health.
3. **Finished shelf / sort** — `GET /me/finished?limit=` (finished_at desc); `GET /books?sort=progress` orders by the caller's `progress.updated_at` desc (nulls last), joined to `Progress`.
4. **Book payload** — `can_edit: bool` on `BookPublic` computed for the caller (admin or uploader); keep `uploaded_by` hidden.

### B. Frontend (`feat/m6-web`)
1. **PWA** — hand-rolled `public/sw.js` (no new dependency): precache the shell (`/`, `/index.html`, `/offline.html`, manifest, icons, built assets discovered via a small build hook or cache-on-fetch for same-origin `assets/`), stale-while-revalidate for covers (`/api/v1/books/*/cover*`), network-only for `/api/` and `/api/v1/audio/`; navigation fallback to `/offline.html`; versioned cache names and cleanup. Register from `main.tsx` only in production. Add `/offline.html` with brand styling and a Retry button.
2. **Admin page** — job table with Retry for failed jobs; TTS status + latency; cache size with Clear all / per-book where available; users read-only. 44px controls, inline errors.
3. **Library** — "Finished" section/tab from `/me/finished`; add `progress` to the sort menu (real now).
4. **Uploader permissions** — use `book.can_edit` instead of `role === "admin"` to show Edit / Book settings / Reprocess / Delete; keep server enforcement.
5. **Chapter numbering** — use `idx+1` consistently on the book page and player.

## Acceptance
- `make test`, `make lint`, web tests/build, Playwright; `BASE=… ./scripts/acceptance.sh`.
- Lighthouse accessibility ≥ 90 (run `npx lighthouse http://localhost:8000/login --only-categories=accessibility --chrome-flags="--headless"`).
- Live: SW registers, offline page shows with the network blocked, covers still render from cache; audio never cached; admin retry works; Finished appears after marking a book finished; `sort=progress` orders; a `user` who uploaded a book sees Edit/Book settings.
