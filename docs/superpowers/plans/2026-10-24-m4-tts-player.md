# Folio M4 (TTS and Player) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Play any book as audio generated on demand from the verified Qwen3 TTS backend, cached on disk, with a gapless mobile player, read-along, mini player and lock-screen controls.

**Architecture:** A `folio/tts/` package owns the client, voice discovery, cache keys, synthesis and eviction. `segment_audio` rows double as the generation queue (claimed `FOR UPDATE SKIP LOCKED` by the worker), so no new job plumbing is needed. The API exposes prepare/stream/voices/preview; the React player keeps two `<audio>` elements and tops up a lookahead window via `prepare`.

**Spec:** `docs/folio-application-spec.md` (TTS audio generation, Player and progress tracking, Screens 6–7, Endpoints)
**Backend contract (verified):** `docs/TTS.md` — `TTS_BASE_URL=http://vllm.dotslash.io:8880/v1`, `GET /audio/voices` → `{"voices":[...],"uploaded_voices":[...]}`, `POST /audio/speech` → `audio/opus` Ogg.

## Global Constraints

- M1–M3 guarantees hold (session, CSRF, ID paths, error envelope, 44 px targets, Lucide, no emoji).
- Always synthesize at speed 1.0; playback speed is `playbackRate` only, so cache entries are shared across speeds.
- Cache key = `sha256(f"{model}|{voice}|{format}|{normalized_text}")`; file at `audio/<key[:2]>/<key>.<ext>`; a cached segment is never re-synthesized.
- Max `TTS_CONCURRENCY` in flight (enforced at 1 per worker process; the cap is a ceiling — record this).
- Retries: 3 attempts, backoff 1 s / 4 s / 16 s, 60 s timeout per request; after that `failed` with a retry path.
- Opus first, mp3 only if the engine rejects opus; `TTS_FORMAT` overrides.
- Eviction never removes a file referenced by a `queued`/`generating` segment or created in the last 10 minutes.
- Progress persistence is **M5**: the player must not write progress yet; `GET /books/{id}` keeps returning `progress: null`.
- Tests never touch the network: use `tests/mock_tts.py` (already exists) or `httpx.MockTransport`.

## Review Focus

1. **Same text, two speeds / two books** → one cache file, one synth call (T-A).
2. **TTS returns 500 then 200** → retries once and succeeds; after 4 failures the segment is `failed` with a retryable error, not a stuck `generating` row (T-A/T-B).
3. **Book with a `zh-TW` language and no per-book voice** → admin default `ashley-zh`, never `ashley-en` (T-A).
4. **Seeking past generated audio** → prepare is called for the target segment first, player shows "Preparing audio…" instead of silence (T-C).
5. **Voice disappears from the engine** → settings shows it as unavailable and playback falls back down the selection order instead of 500ing (T-A/T-D).

---

## Data model (migration 0004)

`audio(cache_key PK, path, format, voice, model, duration_s, bytes, created_at, last_played_at)` and `segment_audio(id, segment_id FK, voice, cache_key FK nullable, status queued|generating|ready|failed, error, priority int default 100, created_at, updated_at)` with a unique index on `(segment_id, voice)`.

## Wave 0 — TTS core (blocking)

### Task A: Client, voices, cache, synthesis, eviction, migration

**Files:** `backend/folio/tts/{__init__,client,voices,cache,text}.py`, `backend/folio/models/audio.py`, `backend/folio/models/__init__.py`, `backend/alembic/versions/0004_audio.py`, `backend/tests/test_tts_{client,voices,cache,text}.py`.

**Interfaces produced:**
- `TtsClient(settings)` — `synthesize(text, voice) -> tuple[bytes, str]` (bytes, format), `list_voices() -> list[Voice]`, 60 s timeout, bearer token when `TTS_API_KEY`, opus→mp3 fallback on 4xx.
- `Voice(id, language: str|None, description: str|None, available: bool = True)`.
- `discover_voices(settings, client, refresh=False) -> list[Voice]` — `/audio/voices` then `/voices`, accepts array of strings / objects / `{voices}` / `{data}` / `uploaded_voices`; language from field, else `TTS_VOICE_LANG_PATTERN` (`kr`→`ko`), else None; TTL cache (`TTS_VOICES_TTL`), `refresh` bypasses it; falls back to `TTS_VOICES`.
- `cache_key(model, voice, fmt, text) -> str`; `normalize_speech_text(text) -> str` (`_prepare_for_speech`: abbreviations, `[12]` markers, URLs→"link", whitespace).
- `cache_path(settings, key, fmt) -> Path`; `duration_seconds(path) -> float` (mutagen).
- `get_or_synthesize(session, settings, client, text, voice) -> Audio` — cache hit returns the row and touches `last_played_at`; miss synthesizes, writes atomically (`.part` then rename), reads duration, upserts `audio`.
- `evict_if_needed(session, settings) -> int` — LRU by `last_played_at`, skips recent/unfinished.
- `select_voice(book, user_settings: dict, settings, voices) -> str` — book override → user per-language → `TTS_VOICE_MAP[lang]` → `TTS_DEFAULT_VOICE`; falls back if the chosen voice is unavailable.

**Tests:** key stability/normalization; voice parsing for all four shapes; `kr`→`ko`; TTL/refresh; selection order incl. missing voice; cache hit makes no HTTP call; retry/backoff with a mock transport; opus→mp3 fallback; eviction skips busy/recent; text prep rules; migration up/down.

## Wave 1 — Parallel (after A)

### Task B: Generation queue, audio endpoints, SSE

**Files:** `backend/folio/tts/queue.py`, `backend/folio/routers/audio.py`, `backend/folio/routers/voices.py`, `backend/folio/routers/admin.py` (cache clear + tts health), `backend/folio/ingest/pipeline.py` (no-op unless chapter-title lead-ins need segments), `backend/tests/test_audio_api.py`, `backend/tests/test_tts_queue.py`.

**Endpoints:** `POST /books/{id}/audio/prepare` `{segment_id, count=lookahead}` → `{items:[{segment_id, status, cache_key, url, duration_s}], lead_in?}`; `GET /audio/{cache_key}` streaming with HTTP Range (206/Content-Range/Accept-Ranges); `GET /voices?refresh=`; `POST /voices/preview` `{voice, text?}` → audio bytes; `POST /admin/cache/clear` `{book_id?}`; admin health `tts` field via `GET {base}/health`.

**Queue:** `prepare` creates `segment_audio(queued)` rows for the current + next `count` segments (skipping cache hits, which become `ready` immediately), notifies `{"event":"audio"}`; `claim_next_tts(session)` uses SKIP LOCKED; `run_tts_job` synthesizes, sets `ready`/`failed`, notifies. The worker loop runs TTS before ingest jobs at equal priority.

### Task C: Player UI

**Files:** `frontend/src/player/{PlayerProvider,usePlayer}.tsx|ts`, `components/{FullPlayer,MiniPlayer,ChapterSheet,ReadAlong}.tsx`, `api/audio.ts`, `AppShell.tsx` (mount MiniPlayer), `App.tsx` (route `/player`), tests.

**Behavior:** two `<audio>` elements, preload next segment, start on `ended`; play/pause, ±15/30 s, prev/next chapter, per-chapter scrubber, 0.75–2.5× in 0.25 steps, sleep timer; prepare on seek/advance (show "Preparing audio…"); auto-advance to the next chapter; Media Session metadata + handlers; mini player on every page; audio refetches on `audio` SSE frames.

**Read-along (explicit product requirement):** render the whole current chapter as continuous paragraphs, map the spoken position (segment index + `currentTime/duration` within it) to a character offset, highlight the active sentence **and** the active line, and auto-scroll the container to keep it near the middle (`scrollIntoView block:"center"`, throttled ~250 ms, `behavior:"auto"` under `prefers-reduced-motion`). A manual scroll pauses auto-follow for ~5 s. Tapping a paragraph seeks to the matching segment/offset. `aria-live="off"` on the moving text.

### Task D: Voice selection UI + book/settings surfaces

**Files:** `frontend/src/api/voices.ts`, `pages/SettingsPage.tsx`, `components/VoicePicker.tsx`, `BookDetailPage.tsx` (narrator override + Play/Resume), `App.tsx` (settings route), tests.

**Behavior:** Settings lists discovered voices per language with Preview; "Show all voices"; unavailable voices marked. Book page has a narrator override picker and enables Play/Resume. Full player gets a Voice button that switches from the current segment (previous cache kept). No progress writes.

## Acceptance

- `make test`, `make lint`, frontend tests/build; Playwright at 390×844.
- Live stack: upload a book, play it; a cached chapter boundary gap < 1 s (measure); voices list shows the five engine voices; preview plays; switching voice regenerates from the current segment; seek ahead shows "Preparing audio…" then plays; Media Session metadata present (assert via `navigator.mediaSession.metadata` in Playwright); admin health reports `tts: ok`.
- Extend `scripts/acceptance.sh`: prepare returns a ready URL; `GET /audio/{key}` supports Range; cache clear removes files; voices endpoint lists `ashley-en`.
