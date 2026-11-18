# Folio — Application Specification

Oct 24, 2026 · @Jimmy

## Overview

Folio is a self-hosted, mobile-friendly web app that turns uploaded ebooks (EPUB, PDF, Kindle) into a shared catalog of books you can listen to as audiobooks. Speech comes from a remote OpenAI-compatible TTS backend, and each user's listening progress is saved and resumed across devices. Users sign in with LDAP (Active Directory).

### Goals

- Upload EPUB, PDF, MOBI and AZW3 files; each becomes one book in the catalog.
- Fetch metadata and a cover automatically; let users edit every field and replace the cover.
- Play any book as audio, generated on demand by an OpenAI-compatible `/v1/audio/speech` endpoint and cached on disk.
- Track progress per user per book, down to the sentence, and resume on any device.
- Work well on a phone: installable PWA, lock-screen controls, background playback.
- Authenticate against LDAP/AD, with roles mapped from directory groups.

### Non-goals (v1)

- DRM removal. DRM-protected and KFX Kindle files are rejected with a clear error.
- Hosting an OCR engine. Scanned PDFs are flagged `needs_ocr`; an admin-configured language model (Admin → AI) can read them instead (2026-11-18).
- Hosting the TTS model itself. Folio is only a client of the TTS API.
- Native mobile apps, public sign-up, or multi-tenant hosting.

### How to use this spec

This document is written to be handed to a coding agent. Build it milestone by milestone (see Milestones), finishing each milestone's acceptance criteria before starting the next. Where the spec says MUST, treat it as a requirement; SHOULD is a strong default; MAY is optional. Anything not covered here: pick the simplest option that fits the stack and record the decision in `docs/DECISIONS.md`.

## Architecture and deployment

Folio is two containers built from one image (an API and a background worker) plus PostgreSQL and a single `/data` volume, deployed with Compose behind the existing nginx reverse proxy.

&#91;embedded content: Folio architecture · 2 app containers, 2 stores, 3 external services\]

The API also calls the TTS API for voice previews and the metadata APIs for interactive "Find metadata" searches; all long-running work goes through the worker.

### Tech stack

| Layer | Choice |
| --- | --- |
| Backend | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.x, Alembic, httpx |
| Book processing | `ebooklib`, BeautifulSoup, PyMuPDF, Calibre CLI (`ebook-convert`, `ebook-meta`), `pysbd`, Pillow |
| Audio | `mutagen` for durations; files served with HTTP Range support |
| Auth | `ldap3` |
| Job queue | the `jobs` table in Postgres, claimed with `SELECT … FOR UPDATE SKIP LOCKED`; `LISTEN/NOTIFY` pushes status to the API for SSE (no Redis) |
| Database | PostgreSQL 16 |
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, TanStack Query, React Router, Lucide icons; built to static files served by the API container |
| Packaging | One OCI image (multi-stage: Node build, then Python runtime with Calibre); runs under Podman or Docker |

### Deployment

- `compose.yaml` with services `api` (`uvicorn`, port 8000), `worker` (same image, `python -m folio.worker`), and `db` (`postgres:16`), plus volumes `folio-data` (mounted at `/data`) and `folio-db`.
- Images pushed to the internal Harbor registry; the README includes the nginx `location` block (WebSocket/SSE-friendly: `proxy_buffering off` on `/api/v1/events`, `client_max_body_size 200m`).
- Migrations run automatically at API start-up.
- Health check: `GET /api/v1/admin/health` (unauthenticated variant `/healthz` returns only OK/not OK).

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FOLIO_BASE_URL` | none (required) | public URL, used for cookies and the PWA manifest |
| `FOLIO_SECRET_KEY` | none (required) | signs CSRF tokens |
| `DATABASE_URL` | none (required) | Postgres connection string |
| `DATA_DIR` | `/data` | originals, covers, audio cache |
| `MAX_UPLOAD_MB` | `200` | upload size limit |
| `LDAP_URL` | none (required) | e.g. `ldaps://dc1.example.local:636` |
| `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` | none (required) | read-only service account |
| `LDAP_BASE_DN` | none (required) | user search base |
| `LDAP_USER_FILTER` | `(&(objectClass=user)(sAMAccountName={username}))` | user lookup |
| `FOLIO_LDAP_ADMIN_GROUP`, `FOLIO_LDAP_USER_GROUP` | none (required) | group DNs mapped to roles |
| `LDAP_CA_FILE` | system store | internal CA bundle |
| `LDAP_ALLOW_INSECURE` | `false` | permit plain LDAP |
| `TTS_BASE_URL` | none (required) | OpenAI-compatible base, e.g. `http://tts.example.local/v1` |
| `TTS_API_KEY` | empty | bearer token, if required |
| `TTS_MODEL` | `tts` | `model` field sent to the API |
| `TTS_FORMAT` | `opus` | `opus` or `mp3` |
| `TTS_DEFAULT_VOICE` | none (required) | last-resort voice, e.g. ashley-en |
| `TTS_VOICE_MAP` | see TTS section | JSON map of language → voice |
| `TTS_VOICES` | empty | comma-separated fallback list, used only if the engine can't list voices (cached per TTS\_VOICES\_TTL, default 600 s) |
| `TTS_MAX_CHARS` | `800` | max characters per segment |
| `TTS_LOOKAHEAD` | `6` | segments generated ahead of playback |
| `TTS_CONCURRENCY` | `4` | max parallel TTS requests (a segment's sentences go out this many at a time) |
| `TTS_CHARS_PER_SECOND` | `15` | duration estimate before audio exists |
| `AUDIO_CACHE_MAX_GB` | `50` | cache eviction threshold |
| `METADATA_ONLINE` | `true` | enable Open Library / Google Books lookups |
| `GOOGLE_BOOKS_API_KEY` | empty | optional |

## Authentication

Login MUST go through LDAP (Active Directory) only; Folio stores no passwords. Roles come from directory group membership at every login.

### Login flow

1. User submits username and password on `/login`.
2. Server binds to LDAPS with a read-only service account and searches for the user (default filter `(&(objectClass=user)(sAMAccountName={username}))`).
3. Server re-binds as the found DN with the submitted password. Failure returns a generic "Invalid username or password".
4. Server reads `memberOf` (including nested groups via `LDAP_MATCHING_RULE_IN_CHAIN`, OID 1.2.840.113556.1.4.1941) and maps groups to a role.
5. User not in any allowed group → login refused with "Your account is not allowed to use Folio".
6. Server upserts the local `users` row (DN, username, display name, email, role, last\_login) and creates a session.

### Roles

| Role | Granted by | Can |
| --- | --- | --- |
| admin | member of `FOLIO_LDAP_ADMIN_GROUP` | everything, including deleting any book, managing jobs, clearing the audio cache, and app settings |
| user | member of `FOLIO_LDAP_USER_GROUP` | browse the catalog, upload books, edit metadata of books they uploaded, listen, and keep their own progress |

### Sessions and security

- Server-side sessions in the database; cookie is `HttpOnly`, `Secure`, `SameSite=Lax`. Sessions last until logout: every use slides the row and both cookies (400 days unused is the only expiry), and the account is re-checked against the directory hourly — a disabled, locked-out, removed or de-grouped account loses every session at once. Any 401 sends the app to the login screen.
- CSRF protection on all state-changing requests (double-submit token header).
- Login rate limit: 10 attempts per username per 15 minutes, then a 15-minute lockout (in Folio, not AD).
- LDAPS (port 636) by default with certificate verification; a configurable CA bundle path for an internal CA. Plain LDAP only if `LDAP_ALLOW_INSECURE=true`.
- Never log passwords or full bind responses.
- Use the `ldap3` Python library.

## Book ingestion

Every upload becomes one book whose text is split into chapters and then sentence-aligned segments; segments are the unit for TTS, playback and progress.

### Supported formats

| Format | Extensions | How it's read |
| --- | --- | --- |
| EPUB 2/3 | `.epub` | `ebooklib` + BeautifulSoup; chapters from the spine, titles from the nav/NCX TOC |
| PDF | `.pdf` | PyMuPDF (`fitz`); chapters from the PDF outline, else one chapter per \~20 pages |
| Kindle | `.mobi`, `.azw`, `.azw3` | Convert to EPUB with Calibre's `ebook-convert`, then read as EPUB |
| Rejected | `.kfx`, DRM-protected files | Fail with "This file is DRM-protected or in an unsupported Kindle format" |

Max upload size defaults to 200 MB (`MAX_UPLOAD_MB`). Detect type by magic bytes, not the extension.

### Pipeline (background job per upload)

1. **Store** the original file under `books/<book_id>/original.<ext>` and record its SHA-256. If the hash already exists, mark the upload as a duplicate and link to the existing book instead of creating another.
2. **Convert** Kindle formats to EPUB (`ebook-convert`, 5-minute timeout).
3. **Extract text** per chapter. Strip scripts, styles, images, footnote back-links and page numbers; keep paragraph breaks.
4. **Clean** text for speech: normalize Unicode (NFKC), collapse whitespace, drop repeated running headers/footers in PDFs (lines repeated on more than 50% of pages), join hyphenated line breaks.
5. **Detect scanned PDFs**: under 200 extractable characters per page on average → status `needs_ocr`, book still added with metadata but marked not playable. When OCR is switched on (Admin → AI), the language model reads every page without a text layer instead and the book continues as usual.
6. **Segment** each chapter into sentences (use `pysbd` with the book's language), then group sentences into segments of at most `TTS_MAX_CHARS` (default 800). Never split a sentence unless it alone exceeds the limit; then split on commas or spaces.
7. **Extract embedded metadata and cover** (see Metadata).
8. **Fetch online metadata** if enabled.
9. Mark the book `ready` and compute an estimated duration (characters ÷ `TTS_CHARS_PER_SECOND`, default 15).

Book statuses: `uploading` → `processing` → `ready` | `needs_ocr` | `failed` (with an error message shown in the UI). A failed job MAY be retried from the book page.

### Text storage

Store chapter and segment text in the database (not just files) so the reader view, search and TTS all use the same source. Each segment keeps its `char_start`/`char_end` within its chapter so progress can be shown as a percentage.

## Metadata

Folio fills metadata from the file first, then from online sources, and every field stays editable; a user's manual edit is never overwritten by a later automatic fetch.

### Fields

| Field | Notes |
| --- | --- |
| Title, subtitle | required; title defaults to the file name |
| Authors | ordered list |
| Series, series index | e.g. "The Expanse", 3 |
| Description | plain text or sanitized HTML |
| Publisher, published date | date may be year only |
| Language | BCP-47 code (`en`, `ja`, `ko`, `zh-TW`); drives sentence splitting and voice choice |
| ISBN-10 / ISBN-13 | validated checksums |
| Tags / subjects | free-form list |
| Narrator voice override | optional per-book TTS voice (see TTS) |
| Cover | image, see below |

### Sources, in order

1. **Embedded**: EPUB OPF metadata, PDF document info, Calibre's `ebook-meta` for Kindle files.
2. **Open Library** (`/search.json`, `/isbn/{isbn}.json`, covers from `covers.openlibrary.org`), no key required.
3. **Google Books** (`/books/v1/volumes?q=`), optional API key (Admin → Metadata, else `GOOGLE_BOOKS_API_KEY`); after a 429 it is paused for a few minutes.

Match by ISBN when present, else by title + first author. Apply an online match automatically only when it's an ISBN match or a title/author similarity of 0.9 or higher; otherwise save the candidates and show "Review metadata matches" on the book page.

### Editing

- An edit form for all fields, available to the uploader and admins.
- A "Find metadata" button that searches both sources with editable query fields and shows results as cards (cover, title, authors, year, source); the user picks one and chooses which fields to apply.
- Track which fields were edited by hand (`locked_fields`); automatic fetches skip them.

### Covers

- Sources: embedded cover, online cover, user upload (JPEG, PNG or WebP, max 10 MB), or paste an image URL (the server downloads it, with a 10 MB limit and a 10-second timeout).
- PDF without a cover: render page 1 as the cover.
- No cover at all: generate a placeholder from the title and author using the brand gradient.
- Store the original, plus resized WebP versions at 600 px and 200 px wide; serve with long cache headers and a content hash in the URL.
- The cover editor MUST allow a simple crop to the 2:3 aspect ratio.

## TTS audio generation

Audio is generated one segment at a time, just ahead of the listener, by calling a remote OpenAI-compatible `POST /v1/audio/speech` endpoint; results are cached on disk so each segment is synthesized once per voice.

### Backend contract

The target is the existing homelab TTS service (Qwen3-TTS behind the `qwen3-tts-openai` API, reachable directly or through the LiteLLM `tts` alias). Folio MUST only rely on the standard OpenAI request shape so any compatible server works:

```json
{"model": "tts", "voice": "serena", "input": "Segment text…", "response_format": "opus", "speed": 1.0}
```

- Auth: `Authorization: Bearer $TTS_API_KEY` when set.
- Voices: listed live from the engine, never hard-coded (see Voice selection).
- Format: `opus` (in an Ogg container) by default; fall back to `mp3` if the server rejects opus. Configurable with `TTS_FORMAT`.
- Always synthesize at speed 1.0. Playback speed is changed in the browser (`playbackRate`), so the cache is shared across speeds.

### Voice selection

Folio MUST discover voices from the TTS engine at runtime, so a voice added to the engine shows up in Folio without a code change or restart. The engine currently offers `ashley-en`, `ashley-ja`, `ashley-kr` and `ashley-zh`, and more will be added.

**Discovery**

- Query `GET {TTS_BASE_URL}/audio/voices`, then `GET {TTS_BASE_URL}/voices` if the first returns 404. Accept a JSON array of strings, an array of objects with `id` or `name` (plus optional `language`, `description`), or either wrapped as `{"voices": [...]}` or `{"data": [...]}`.
- If neither endpoint exists, use the comma-separated `TTS_VOICES` setting.
- Cache the list for `TTS_VOICES_TTL` seconds (default 600). Settings re-queries when opened, and admins get a "Refresh voices" button.
- Language of each voice: the `language` field if the engine sends one, else the ID suffix matched by `TTS_VOICE_LANG_PATTERN` (default `-(en|ja|kr|ko|zh)$`, with `kr` treated as `ko`), else "any language".
- If a saved voice disappears from the engine, fall back to the next rule below and show "No longer available" next to it in Settings.

**Selection order**

Voice is chosen in this order: the book's narrator override, then the user's voice for the book's language, then the admin default for that language, then `TTS_DEFAULT_VOICE`. Admin defaults ship as config (`TTS_VOICE_MAP`) and can be changed on the Admin page:

| Language | Default voice |
| --- | --- |
| `en` | `ashley-en` |
| `ja` | `ashley-ja` |
| `ko` | `ashley-kr` |
| `zh`, `zh-TW` | `ashley-zh` |

**Choosing voices in the UI**

- Settings: for each language, a dropdown of the engine's voices for that language (a "Show all voices" toggle lists every voice), each with a Preview button that speaks a short sample in that language.
- Book page: the same picker as the narrator override for that book.
- Full player: a Voice button to switch mid-book. Switching regenerates audio from the current segment onward; the previous voice's cached audio is kept.

### Generation strategy

- **On demand with lookahead.** When playback starts, queue the current segment plus the next `TTS_LOOKAHEAD` segments (default 6). Keep the queue topped up as playback advances.
- **Priority.** Segments needed now go first; lookahead is lower priority; an optional "Download whole book" job is lowest.
- **Concurrency.** At most `TTS_CONCURRENCY` (default 4) requests in flight across all users, so the shared GPU is not swamped; a segment's sentences are synthesized that many at a time.
- **Cache key** = SHA-256 of `model | voice | format | normalized text`. Files live at `audio/<key[0:2]>/<key>.<ext>` and are reused across books and users.
- **Retries.** Retry 3 times with exponential backoff (1 s, 4 s, 16 s) on timeouts and 5xx. After that, mark the segment failed; the player shows "Couldn't generate this part" with a retry button and can skip ahead.
- **Timeouts.** 60-second request timeout per segment.
- **Cache limits.** `AUDIO_CACHE_MAX_GB` (default 50); when exceeded, evict least-recently-played files, never those within the lookahead window of an active session. Admins can clear the cache per book or entirely.
- **Duration.** After each file is written, read its exact duration (`mutagen`) and store it on the audio record so the scrubber and time-remaining are accurate for generated parts.

### Text preparation for speech

Before sending a segment: expand common abbreviations only where safe ("Dr." → "Doctor" before a name, "e.g." → "for example"), drop bracketed footnote markers like `[12]`, and replace URLs with "link". Chapter titles are spoken as their own short segment before the chapter's first sentence.

## Player and progress tracking

The player plays a book as a continuous sequence of segment audio files and saves the listener's position (chapter, segment, offset in seconds) so they can resume exactly where they stopped, on any device.

### Player behavior

- Gapless-feeling playback: fetch the next segment's audio into memory ahead of time and start it on the same `<audio>` element from its `ended` handler, without a visible pause (one element: iOS ties the lock screen and background playback to it).
- Where the browser plays HLS natively (Safari, iOS) and `TTS_FORMAT=aac`, the book plays as one HLS stream instead (`GET /api/v1/books/{id}/stream.m3u8?voice=&from=`): the media player itself fetches clip after clip, so playback continues across clip and chapter boundaries on a locked iPhone, whose page JavaScript is frozen. The playlist lists the generated run of AAC clips from `from` (EVENT, `EXT-X-ENDLIST` once the book is complete); each segment is the clip prefixed with its ID3 timestamp; `stream.json` gives the player the same timeline to map `currentTime` to a segment.
- Controls: play/pause, back 15 s, forward 30 s, previous/next chapter, a scrubber for the current chapter, speed 0.75×–2.5× in 0.25 steps, and a sleep timer (15, 30, 45, 60 min, or end of chapter).
- Seeking past segments that aren't generated yet: jump to that segment, raise its priority, show a short "Preparing audio…" state.
- Chapter list sheet showing each chapter's title, estimated length, and a check mark once finished.
- "Read along" panel showing the current segment's text with the current sentence highlighted (sentence timing estimated by character share of the segment's duration).
- Media Session API: title, author, chapter, cover artwork, and lock-screen/headset controls (play, pause, seek back, seek forward, previous/next track = previous/next chapter).
- A persistent mini player on all pages while a book is loaded; tapping it opens the full player.
- Playback continues when the screen locks (standard `<audio>` element, no Web Audio graph needed).

### Progress model

One `progress` row per user per book: `chapter_id`, `segment_id`, `offset_seconds`, `percent` (by characters), `updated_at`, `device_label`, and `finished_at`.

- Each chapter also keeps its own place and a listened flag (`chapter_progress`): every save updates the saved chapter's row, and a chapter played to its end is marked listened and starts over next time. Choosing a chapter resumes where it was left; auto-advance starts the next chapter at its beginning.
- Save every 10 seconds while playing, on pause, on chapter change, and on `visibilitychange`/`pagehide` (use `navigator.sendBeacon`).
- On load, resume from the saved position, rewinding 3 seconds for context.
- Conflicts across devices: last write wins by `updated_at`. If another device's saved position is more than 60 seconds ahead of where this device is about to resume, show "Continue from \<chapter, time> on \<device>?".
- Mark a book finished when the last segment ends; it moves from "Continue listening" to "Finished". A user can reset progress or mark as unfinished.
- Bookmarks MAY be added in v1.1 (a position plus an optional note).

### Per-user listening settings

Default speed, per-language voices, skip intervals, auto-play next chapter (on by default), and whether to speak chapter titles.

## Data model and REST API

PostgreSQL holds all state except binary files; the API is JSON over `/api/v1`, documented automatically by FastAPI's OpenAPI page.

### Tables

| Table | Key columns |
| --- | --- |
| `users` | id, ldap\_dn, username, display\_name, email, role, settings (JSONB), created\_at, last\_login\_at |
| `sessions` | id (random 32 bytes), user\_id, csrf\_token, user\_agent, expires\_at |
| `books` | id (UUID), title, subtitle, authors (array), series, series\_index, description, publisher, published\_date, language, isbn10, isbn13, tags (array), narrator\_voice, cover\_key, status, error, locked\_fields (array), uploaded\_by, total\_chars, est\_duration\_s, created\_at, updated\_at |
| `book_files` | id, book\_id, kind (`original` / `converted`), format, path, size\_bytes, sha256 |
| `chapters` | id, book\_id, idx, title, char\_count |
| `segments` | id, chapter\_id, idx, text, char\_start, char\_end |
| `audio` | cache\_key (PK), path, format, voice, model, duration\_s, bytes, created\_at, last\_played\_at |
| `segment_audio` | segment\_id, voice, cache\_key, status (`queued` / `generating` / `ready` / `failed`), error |
| `progress` | user\_id, book\_id, chapter\_id, segment\_id, offset\_s, percent, device\_label, updated\_at, finished\_at |
| `chapter_progress` | user\_id, chapter\_id, book\_id, segment\_id (null = chapter start), offset\_s, updated\_at, finished\_at |
| `metadata_candidates` | id, book\_id, source, payload (JSONB), score |
| `jobs` | id, type, book\_id, priority, status, attempts, error, created\_at, finished\_at |

Use SQLAlchemy 2.x models and Alembic migrations. Index `segments(chapter_id, idx)`, `progress(user_id, updated_at)`, and full-text search on books (`title`, `authors`, `series`, `tags`).

### Endpoints

| Method & path | Purpose |
| --- | --- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | session login/logout, current user |
| `GET /books?q=&sort=&status=&page=` | catalog list with search, sort (recent, title, author, progress) and paging |
| `POST /books` (multipart, multiple files) | upload; returns one book id + job id per file |
| `GET /books/{id}` | metadata, chapters, the caller's progress |
| `PATCH /books/{id}` | edit metadata (sets `locked_fields`) |
| `DELETE /books/{id}` | delete book, files and progress (admin or uploader) |
| `POST /books/{id}/cover` / `PUT /books/{id}/cover-url` | upload a cover / set from URL |
| `GET /books/{id}/metadata/search?q=&isbn=` | search online sources |
| `POST /books/{id}/metadata/apply` | apply a candidate, chosen fields only |
| `POST /books/{id}/reprocess` | retry ingestion |
| `GET /books/{id}/chapters/{chapterId}/segments` | segment list with text and audio status |
| `POST /books/{id}/audio/prepare` | body: segment id + count; queues generation and returns statuses |
| `GET /audio/{cacheKey}` | stream audio (supports HTTP `Range`) |
| `GET /books/{id}/progress`, `PUT /books/{id}/progress` | read/save progress |
| `GET /me/continue` | in-progress books, most recent first |
| `GET /voices`, `POST /voices/preview` | voices reported by the TTS engine, grouped by language (`?refresh=true` re-queries the engine); sample audio |
| `GET /me/settings`, `PUT /me/settings` | listening settings |
| `GET /admin/jobs`, `POST /admin/cache/clear`, `GET /admin/health` | admin tools; health includes DB, worker and TTS checks |
| `GET /events` (Server-Sent Events) | live job and audio status updates for the UI |

All endpoints except login and health require a session. Errors return `{"error": {"code": "…", "message": "…"}}` with a proper HTTP status.

## UI, UX and brand

The UI is mobile-first (designed at 390 px wide, scaling up to desktop), installable as a PWA, with light and dark themes that follow the system setting and can be overridden in Settings.

### Brand

The logo is an open book drawn as a three-quarter-view box, with a blue-to-violet gradient body, a lighter periwinkle top page, and a white play triangle on the front, next to a bold geometric "Folio" wordmark. Ship the mark as `logo.svg` (mark only), `logo-wordmark.svg` (mark + text), plus PNG app icons at 512, 192, 180 (Apple touch) and 32 px, and a maskable 512 px icon with the mark inside the central 80% safe zone.

| Token | Value (approximate, sampled from the artwork) | Use |
| --- | --- | --- |
| `--brand-blue` | `#2381F7` | gradient start, primary buttons, active states |
| `--brand-violet` | `#8B5CF6` | gradient end, highlights |
| `--brand-gradient` | `linear-gradient(135deg, #2381F7 0%, #8B5CF6 100%)` | logo body, player progress fill, placeholder covers |
| `--brand-tint` | `#8EA2F9` | the logo's top page, subtle accents |
| `--ink` | `#1E2235` | text on light, dark app background, dark icon tile |
| `--surface-light` | `#F6F7FB` | light page background |
| `--surface-dark` | `#12141F` | dark page background |
| `--muted` | `#5B6275` light / `#A3A9BA` dark | secondary text (must meet 4.5:1 contrast) |

Type: wordmark and headings in **Outfit** 600–700; body and UI in **Inter** 400–600. Corner radius 12 px for cards, 999 px for pills. Icons: Lucide, 1.75 px stroke. No emoji in the UI.

### Screens

1. **Login**: logo, "Sign in with your directory account", username, password, sign-in button; errors inline.
2. **Library (home)**: "Continue listening" horizontal row (cover, title, progress bar, time left), then the catalog as a cover grid (2 columns on phones, up to 6 on desktop). Search bar, sort menu, filters (language, status, finished/unfinished). Upload button in the header.
3. **Upload**: drag-and-drop zone plus file picker, multiple files at once, per-file progress, then live processing status via SSE; each finished item links to its book.
4. **Book detail**: large cover, title, authors, series, description (expandable), language, estimated length, big Play/Resume button with progress, chapter list, and Edit / Find metadata / Delete actions for permitted users.
5. **Edit metadata**: form for all fields, cover editor with upload, URL, and 2:3 crop; "Find metadata" results as selectable cards with per-field apply checkboxes.
6. **Player (full screen)**: cover with a soft brand-gradient glow behind it, book and chapter titles, scrubber with elapsed/remaining, controls row (back 15, play/pause, forward 30), secondary row (speed, sleep timer, chapters, read-along, voice).
7. **Mini player**: fixed bottom bar above the safe area with cover thumbnail, titles, play/pause and a thin gradient progress line.
8. **Settings**: theme, default speed, per-language voice with preview, skip intervals, auto-play next chapter.
9. **Admin**: job queue with retry, TTS backend status and latency, audio cache size with clear buttons, user list (read-only, from LDAP).

### UX rules

- Touch targets at least 44 × 44 px; respect `env(safe-area-inset-*)`.
- Every list has an empty state (e.g. "No books yet — upload your first EPUB, PDF or Kindle file").
- Skeleton loaders for the library grid; optimistic updates for metadata edits.
- Keyboard: space toggles play, arrow keys seek on desktop; full screen-reader labels on icon buttons.
- PWA: web manifest with brand colors (`theme_color` `#1E2235`), a service worker caching the app shell and covers (not audio by default), and an offline page.

## Quality, testing and milestones

Build in six milestones; each ends with tests passing and its acceptance criteria demonstrated on a phone-sized browser.

### Non-functional requirements

- **Performance**: library page loads in under 1 s with 1,000 books; playback of an already-cached segment starts within 500 ms; a 500-page EPUB ingests in under 60 s (excluding TTS).
- **Scale target**: up to 10 users, 5,000 books, 200 GB of audio.
- **Security**: all file paths built from IDs, never from user input; uploads scanned by type; HTML from books sanitized (`bleach`); dependencies pinned; containers run as non-root.
- **Observability**: JSON logs to stdout; Prometheus metrics at `/metrics` (TTS requests, latency, failures, queue depth, cache bytes, active listeners).
- **Backups**: everything restorable from the Postgres dump plus the `/data` volume; document the steps in `docs/BACKUP.md`.
- **Code quality**: Python typed and checked with `ruff` and `mypy`; frontend with ESLint and `tsc --noEmit`.

### Testing

- Backend unit tests (`pytest`) for segmentation, text cleaning, voice selection, cache keys, metadata matching and permissions.
- Integration tests against a mock OpenAI TTS server (returns a short silent opus file) and a test LDAP server (`osixia/openldap` container) in CI.
- Fixture books: one EPUB 3, one EPUB 2, one PDF with an outline, one PDF without, one AZW3, one scanned PDF, one DRM-flagged file. Use public-domain texts (e.g. Project Gutenberg) only.
- Frontend: Playwright smoke tests at 390 × 844 for login, upload, play, resume.

### Milestones

1. **Skeleton and auth.** Compose stack, DB migrations, LDAP login/logout, roles, empty library page with brand theme. *Done when*: an AD user in the user group can log in, a user outside both groups is refused, and an admin sees the Admin menu.
2. **Upload and ingestion.** Upload UI, job worker, EPUB/PDF/Kindle pipeline, chapters and segments, status updates via SSE. *Done when*: each fixture book reaches its expected status, and duplicates are detected.
3. **Metadata and covers.** Embedded extraction, Open Library and Google Books lookup, edit form, Find metadata, cover upload/URL/crop, placeholder covers. *Done when*: an EPUB with an ISBN gets the correct cover automatically and a manual edit survives a re-fetch.
4. **TTS and player.** TTS client, cache, lookahead queue, full player, mini player, read-along, Media Session. *Done when*: a book plays across a chapter boundary without a gap longer than 1 s once cached, and lock-screen controls work on iOS Safari and Android Chrome.
5. **Progress and settings.** Progress saving and resume, cross-device prompt, Continue listening row, per-language voices with preview, finished state. *Done when*: starting on a phone and continuing on a desktop resumes within 3 seconds of the stop point.
6. **PWA and polish.** Manifest, icons, service worker, offline page, admin tools, metrics, accessibility pass, docs (README, CONFIG, BACKUP, DECISIONS). *Done when*: the app installs to a phone home screen and passes a Lighthouse accessibility score of 90 or higher.

### Repository layout

```
folio/
  backend/        # FastAPI app, worker, Alembic migrations, tests
  frontend/       # React + Vite + TypeScript + Tailwind PWA
  docs/           # README, CONFIG, BACKUP, DECISIONS
  compose.yaml
  .env.example
```
