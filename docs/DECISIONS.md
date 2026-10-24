# Decisions

One line each: decision, why, what it costs.

- **psycopg 3 + sync SQLAlchemy** — one driver, sync sessions everywhere; costs: no async DB access, every route runs on threadpool workers.
- **TTS_* optional until M4** — `TTS_BASE_URL`/`TTS_DEFAULT_VOICE` have no defaults in the spec but the M1–M2 stack must boot without a TTS backend; validated when the TTS client is first constructed; costs: a TTS misconfiguration surfaces at M4, not at start-up.
- **`FOLIO_TEST_MODE` test-login endpoint** — headless tests/e2e need a session without a real LDAP server; `POST /api/v1/test/login` is mounted only when the flag is true and only `compose.test.yaml` may set it; costs: a test-only attack surface if the flag ever ships to production.
- **Gitignored generated fixture books** — binaries bloat the repo and public-domain texts must not be committed; `make fixtures` regenerates all seven; costs: a first `make test` needs `make fixtures` first.
- **CI deferred to M6** — no pipeline config until the stack is stable; checks run locally via `make lint`/`make test`; costs: regressions depend on developer discipline until M6.
- **pysbd language fallback via `LANGUAGE_CODES`** — pysbd raises `ValueError` on unknown ISO codes, so `segment.py` checks the base language (`language.split("-")[0]`) against pysbd's supported set and falls back to `en`; costs: a book tagged with an unsupported language is segmented with English rules silently.
- **Segments are exact chapter-text substrings** — every sentence/segment satisfies `text[char_start:char_end] == piece.text`, so packed segments keep the whitespace between their sentences; costs: TTS input may carry leading/trailing spaces or paragraph newlines (harmless for speech, required for progress percentages).
- **Duck-typed chapters in `clean_chapters`** — T5a's `ExtractedChapter` is not merged yet, so `clean`/`segment` take any object with `.title`/`.text` and `clean_chapters` rebuilds via `dataclasses.replace` to preserve the input type; costs: chapters must stay dataclasses with a `text` field.
