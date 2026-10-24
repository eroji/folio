# Folio M3 (Metadata and Covers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every book gets the best available metadata and cover automatically, all fields stay editable, and a manual edit is never overwritten by a later automatic fetch.

**Architecture:** Two independent services behind the existing FastAPI app: `folio/covers.py` (validate → store original → render 600/200 WebP → serve with content-hash caching) and `folio/metadata/` (Open Library + Google Books providers → normalized candidates → similarity/ISBN decision → auto-apply or persist for review). Ingestion calls both after the embedded-metadata step; the UI gets an edit screen, a "Find metadata" panel, and a 2:3 cover editor.

**Tech Stack:** Existing stack only. `httpx` for providers (injected client, `MockTransport` in tests), Pillow for WebP resizing, `difflib.SequenceMatcher` for similarity, existing React/TanStack Query.

**Spec:** `docs/folio-application-spec.md` (Metadata, Covers, Screens 4–5, Endpoints)

## Global Constraints

- All M1–M2 guarantees still hold: session on every route, CSRF on every mutation, paths from IDs, errors in the `{"error":{code,message}}` envelope.
- `locked_fields` is the contract: any field written by a human is appended to it, and no automatic fetch (embedded, online, cover) may overwrite a locked field.
- Automatic application only on an ISBN match or a title/author similarity ≥ 0.9; everything else is saved as a candidate and shown for review.
- No test may touch the network. Providers take an injected `httpx.Client`; tests use `httpx.MockTransport`. `conftest.py` sets `METADATA_ONLINE=false` for every test that does not opt in.
- Uploaded/pasted covers: JPEG, PNG or WebP only, max 10 MB, magic-byte checked; a pasted URL is fetched with a 10 s timeout and a 10 MB cap, rejected otherwise.
- Covers are served as WebP at 600 px and 200 px wide (plus the original), with `Cache-Control: public, max-age=31536000, immutable` and `ETag` derived from the content hash.
- Metadata HTML from providers is sanitized with `bleach` before storage or display.
- Mobile-first at 390 px; no new dependency for the crop (canvas); icons Lucide 1.75 px.

## Review Focus

1. **A manual edit followed by reprocess** → the edited fields are unchanged, automatic fields may refresh (pinned by T-C and T-B tests).
2. **Provider returns HTML in `description`** → stored/rendered as safe text, never raw markup (T-B).
3. **An ISBN match with a wildly different title** → auto-applied because ISBN wins; a near-title match without ISBN → candidate only (T-B).
4. **A pasted cover URL that 404s, times out, or exceeds 10 MB** → clean 4xx, existing cover untouched (T-A).
5. **Two rapid PATCHes** → `locked_fields` accumulates, no duplicate entries, latest value wins (T-C).

---

## File structure

```
backend/folio/covers.py             # validate, store, resize, resolve paths, delete
backend/folio/routers/covers.py     # POST cover (upload), PUT cover-url, GET cover?size=
backend/folio/metadata/__init__.py  # Candidate dataclass, provider protocol
backend/folio/metadata/openlibrary.py
backend/folio/metadata/googlebooks.py
backend/folio/metadata/match.py     # normalize, similarity, decide(auto|candidate)
backend/folio/metadata/service.py   # search(), apply(), auto_fetch() (used by pipeline)
backend/folio/routers/metadata.py   # search, apply, candidates list
backend/folio/routers/books.py      # + PATCH /books/{id} (T-C only)
backend/folio/ingest/pipeline.py    # + online metadata + cover fetch (T-B only)
backend/alembic/versions/0003_metadata_candidates.py
frontend/src/pages/EditBookPage.tsx
frontend/src/components/{MetadataFields,FindMetadata,CoverEditor}.tsx
frontend/src/api/metadata.ts
```

---

## Wave 0 — Covers service (blocking)

### Task A: Cover storage, resizing and endpoints

**Files:** `backend/folio/covers.py`, `backend/folio/routers/covers.py`, `backend/tests/test_covers.py`, plus mount lines the lead merges in `main.py`.

**Interfaces produced:**
- `detect_image_type(data: bytes) -> str | None` → `"jpeg" | "png" | "webp" | None` by magic bytes.
- `store_cover(settings, book_id: UUID, data: bytes) -> str` — validates type/size, writes `covers/<id>/original.<ext>`, renders `cover-600.webp` and `cover-200.webp` (2:3 center crop, width 600/200), returns the sha256 hex to store in `books.cover_key`.
- `cover_path(settings, book_id, size: Literal[200, 600] | None) -> Path | None`
- `delete_covers(settings, book_id) -> None`
- `download_cover(url: str, client: httpx.Client) -> bytes` — 10 s timeout, 10 MB cap, type check, raises `ApiError("cover_invalid", ...)`.

**Endpoints:** `POST /api/v1/books/{id}/cover` (multipart `file`, CSRF, admin-or-uploader), `PUT /api/v1/books/{id}/cover-url` (JSON `{url}`, CSRF, same permission), `GET /api/v1/books/{id}/cover?size=200|600|original` (session required; WebP for sized variants; `ETag: "<cover_key>-<size>"`, 304 on `If-None-Match`).

**Steps:** failing tests for type/size validation, 2:3 output dimensions, ETag/304, permission, URL 404/timeout/oversize (MockTransport) → implement → verify → commit. No migration (the `cover_key` column already exists).

---

## Wave 1 — Parallel (after A merges)

### Task B: Online metadata, matching, pipeline integration

**Files:** `backend/folio/metadata/{__init__,openlibrary,googlebooks,match,service}.py`, `backend/folio/routers/metadata.py`, `backend/folio/ingest/pipeline.py`, `backend/alembic/versions/0003_metadata_candidates.py`, `backend/tests/test_metadata_{match,providers,service}.py`.

**Interfaces consumed:** `covers.store_cover`, `covers.download_cover`, existing `EmbeddedMetadata`.
**Interfaces produced:**
- `Candidate(id, source, title, authors, published_date, publisher, description, language, isbn10, isbn13, series, series_index, tags, cover_url, score)`.
- `Provider` protocol: `search(query: str | None, isbn: str | None, client: httpx.Client) -> list[Candidate]`.
- `similarity(title_a, title_b, author_a, author_b) -> float` (0.7 title + 0.3 first author, `SequenceMatcher` on normalized strings).
- `decide(book, candidate) -> Literal["auto", "candidate"]` — auto on ISBN equality or score ≥ 0.9.
- `search_book(settings, query, isbn) -> list[Candidate]` (Open Library then Google Books, deduped by ISBN/title).
- `apply_candidate(book, candidate, fields: list[str], settings) -> list[str]` — writes only requested, non-locked fields; returns applied names; sanitizes description.
- `auto_fetch(session, settings, book, client) -> None` — called by the pipeline after embedded metadata: search, decide, auto-apply the best match or persist all as `metadata_candidates`; if the book still has no cover, download the match's `cover_url` and `store_cover`.

**Migration 0003:** `metadata_candidates(id UUID pk, book_id FK cascade, source text, payload JSONB, score float, created_at)`.

**Endpoints:** `GET /api/v1/books/{id}/metadata/search?q=&isbn=` → `{items:[Candidate]}`, `POST /api/v1/books/{id}/metadata/apply` body `{source, payload, fields[]}` → `{book, applied}`, `GET /api/v1/books/{id}/metadata/candidates` → saved candidates. CSRF on apply; edit permission on all three.

**Pipeline:** call `auto_fetch` only when `settings.metadata_online`; never let a provider failure fail ingestion (log and continue).

**Tests:** canned JSON for both providers via `MockTransport`; ISBN auto-apply; 0.9 boundary; candidate saved below threshold; locked field untouched; HTML description sanitized; provider 500/network error does not fail ingest; cover auto-download; `METADATA_ONLINE=false` skips all calls (assert no request made).

### Task C: Editable metadata (PATCH + locked_fields)

**Files:** `backend/folio/routers/books.py` (PATCH only), `backend/tests/test_books_edit.py`.

**Contract:** `PATCH /api/v1/books/{id}` accepts any subset of the metadata fields, validates ISBN-10/13 checksums and BCP-47-ish language codes, writes only provided fields, appends each provided field name to `locked_fields` (no duplicates), never clears `locked_fields`, and returns the public book. Permission: admin or uploader, CSRF required. Edits are optimistic in the UI (TanStack) but the server response is authoritative.

**Tests:** each field editable; partial payload leaves others untouched; ISBN checksum rejection; locked_fields deduped; reprocess after edit keeps the edited values; non-uploader gets 403.

### Task D: Edit screen, Find metadata, cover editor

**Files:** `frontend/src/pages/EditBookPage.tsx`, `frontend/src/components/{MetadataFields,FindMetadata,CoverEditor}.tsx`, `frontend/src/api/metadata.ts`, routes in `App.tsx`, `BookDetailPage` actions; tests `src/pages/EditBookPage.test.tsx`, `src/components/CoverEditor.test.tsx`, `e2e/metadata.spec.ts`.

**Contract:** consumes the three metadata endpoints, `PATCH /books/{id}`, `POST /books/{id}/cover` (multipart), `PUT /books/{id}/cover-url`; uses the existing `api` client (CSRF automatic) except the multipart upload, which follows `api/books.ts`'s XHR pattern.
**UI:** edit form for every spec field with authors/tags as reorderable lists; "Find metadata" panel with query fields (title/author/ISBN), result cards (cover, title, authors, year, source) and per-field apply checkboxes; "Review metadata matches" banner on the book page when saved candidates exist; cover editor with upload, paste-URL, and a 2:3 canvas crop (drag to pan, zoom slider, exports 1200×1800 WebP) with a live preview; save/cancel, inline errors, optimistic update.

**Tests:** form submits only changed fields and marks them locked; find-metadata renders cards and applies selected fields; crop exports 2:3; cover upload shows the new image; e2e (written, run by the lead) edits a title, reprocesses, and sees the edit preserved.

---

## Merge order and acceptance

1. A merges first (B and D import its interfaces).
2. B, C, D merge in any order; `main.py` mount lines and `docs/DECISIONS.md` are lead-resolved.
3. `make test`, `make lint`, `npm test`, `npx tsc --noEmit`, `npm run build`.
4. Live acceptance on the compose stack: upload the ISBN EPUB → cover appears automatically (mocked provider in the app is not possible live, so the e2e uses the fixture route below); edit a field, reprocess, confirm it survives; replace the cover via URL; crop-upload a cover; open "Find metadata" and apply one field.
5. Extend `scripts/acceptance.sh` with the M3 checks that need no internet: PATCH → reprocess → value preserved; cover upload → 600/200 variants exist; cover URL rejection; candidates list.
