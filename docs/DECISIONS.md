# Decisions

One line each: decision, why, what it costs.

- **psycopg 3 + sync SQLAlchemy** — one driver, sync sessions everywhere; costs: no async DB access, every route runs on threadpool workers.
- **TTS_* optional until M4** — `TTS_BASE_URL`/`TTS_DEFAULT_VOICE` have no defaults in the spec but the M1–M2 stack must boot without a TTS backend; validated when the TTS client is first constructed; costs: a TTS misconfiguration surfaces at M4, not at start-up.
- **`FOLIO_TEST_MODE` test-login endpoint** — headless tests/e2e need a session without a real LDAP server; `POST /api/v1/test/login` is mounted only when the flag is true and only `compose.test.yaml` may set it; costs: a test-only attack surface if the flag ever ships to production.
- **Gitignored generated fixture books** — binaries bloat the repo and public-domain texts must not be committed; `make fixtures` regenerates all seven; costs: a first `make test` needs `make fixtures` first.
- **CI deferred to M6** — no pipeline config until the stack is stable; checks run locally via `make lint`/`make test`; costs: regressions depend on developer discipline until M6.
- **React 19 instead of the spec's React 18** — current major, same API for everything Folio uses; costs: none expected, only third-party peer-dependency friction.
- **Tailwind 4 CSS-first tokens** — theme lives in `tokens.css` via `@theme`, no `tailwind.config.js`; costs: config-file examples from older Tailwind don't apply.
- **PyMuPDF pinned to 1.26** — 2.0 removed the legacy `fitz` module; import `pymupdf`; costs: capped below 2.x until its API settles.
- **Tags in the FTS index via an IMMUTABLE wrapper function** — the expression index needs an immutable expression to fold `books.tags` into the searchable text; costs: one extra SQL function that must stay in sync with the index definition in migrations.
- **pysbd language fallback via `LANGUAGE_CODES`** — pysbd raises `ValueError` on unknown ISO codes, so `segment.py` checks the base language (`language.split("-")[0]`) against pysbd's supported set and falls back to `en`; costs: a book tagged with an unsupported language is segmented with English rules silently.
- **Segments are exact chapter-text substrings** — every sentence/segment satisfies `text[char_start:char_end] == piece.text`, so packed segments keep the whitespace between their sentences; costs: TTS input may carry leading/trailing spaces or paragraph newlines (harmless for speech, required for progress percentages).
- **Duck-typed chapters in `clean_chapters`** — `clean`/`segment` take any object with `.title`/`.text` and `clean_chapters` rebuilds via `dataclasses.replace` to preserve the input type; costs: chapters must stay dataclasses with a `text` field.
- **`TEST_DATABASE_URL` + auto-created `folio_test`** — the harness connects to the server's `postgres` db and creates the test database when missing, so `make test` works on a fresh box; costs: the folio role needs CREATEDB rights on the dev server.
- **Detection-only AZW3 stub when Calibre is absent** — `make_fixtures` writes a minimal PalmDB file with the `BOOKMOBI` magic so all seven fixture keys always exist and `detect_format` is testable; costs: `extract_kindle` tests must skip without Calibre (real conversion runs in the Docker image).
- **Embedded ffmpeg-generated silent Ogg/Opus in `mock_tts.py`** — one 1-second real Opus file as base64, no network or runtime encoder needed; costs: the bytes are frozen; regenerate with `ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:a libopus` if ever needed.
- **`asyncio_mode = auto` in `pyproject.toml`** — async `client` fixtures work without per-test decorators; costs: none.
- **Shared ingest types in `folio/ingest/__init__.py`** — Task 5a's file list has no `types.py` and the readers must not import each other; costs: the package `__init__` is the public surface for `ExtractedBook`/`UnsupportedFormat`/`ScannedPDF`.
- **Kindle metadata via `ebook-meta` text parsing** — the plan pins `ebook-meta` for fields the converted EPUB lacks; we parse its stable `Key : value` output and only fill empty fields; costs: breaks if Calibre changes its output format, first author only.
- **PDF front matter before the first outline entry is dropped** — outline entries define chapter starts; costs: a title page ahead of the first bookmark is not spoken.
- **React 19 (19.3.1), not the spec's React 18** — pinned by the M1–M2 plan; the spec table predates the plan; costs: none known, `@types/react` 19 conventions (ref as prop) apply.
- **ESLint 10 flat config (`eslint.config.js`)** — `.eslintrc.cjs` is removed in ESLint 9+; the plan's file list predates the pin; costs: none, config lives in one file.
- **Theme via `[data-theme]` + semantic CSS vars, no `dark:` variants** — components consume `bg-page`/`text-ink`/`text-muted` mapped through `@theme inline`, so light/dark flips cascade from one token block; costs: brand-specific dark tweaks need a new token instead of a `dark:` class.
- **Admin jobs table accepts bare array or `{items}`** — `GET /admin/jobs` response shape isn't pinned until T2 merges; costs: drop the normalization once the backend contract lands.
- **Job statuses `queued → running → done | failed`** — the spec pins the `jobs` columns but not the status vocabulary; costs: the M3 admin jobs table must map these values to labels.
- **`jobs.notify` commits before/while sending** — Postgres delivers NOTIFY only at transaction end, so a caller's open transaction would silently drop the event; costs: `notify` cannot be part of a larger atomic unit.
- **`worker.run_once(session, settings) -> bool`** — the claim/dispatch/finish/notify body is extracted from `main()` so tests drive one iteration without threads or signals; costs: one extra module-level function beyond the plan's pinned surface.
