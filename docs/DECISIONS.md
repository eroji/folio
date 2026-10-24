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
