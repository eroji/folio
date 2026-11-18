# Configuration

Every setting is an environment variable, read from `.env` at start-up (copy `.env.example`). Missing required variables fail start-up loudly. LDAP and TTS endpoints are reached **only** through these variables — there is no other config file, and no test ever contacts a real directory or TTS server.

## Core

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `FOLIO_BASE_URL` | none | **required** | Public URL; used for cookies and the PWA manifest. |
| `FOLIO_SECRET_KEY` | none | **required** | Signs CSRF tokens. |
| `DATABASE_URL` | none | **required** | Postgres connection string. The compose stack overrides it to point at the `db` service; the value here is what local dev/tests use. |
| `DATA_DIR` | `/data` | optional | Originals, covers, audio cache. Compose overrides it to the `folio-data` volume; local dev uses `./data`. |
| `MAX_UPLOAD_MB` | `200` | optional | Upload size limit. Keep nginx `client_max_body_size` at or above it. |

## LDAP / Active Directory

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `LDAP_URL` | none | **required** | e.g. `ldaps://dc1.example.local:636`. Plain LDAP only if `LDAP_ALLOW_INSECURE=true`. |
| `LDAP_BIND_DN` | none | **required** | Read-only service account DN. |
| `LDAP_BIND_PASSWORD` | none | **required** | Never logged. |
| `LDAP_BASE_DN` | none | **required** | User search base. |
| `LDAP_USER_FILTER` | `(&(objectClass=user)(sAMAccountName={username}))` | optional | Supports `{username}` (bare name — `DOMAIN\user`, `user@domain` and `user` all normalize to `user`) and `{upn}` (`user@domain`, derived from the base DN's `dc=` parts). Both are escaped. On AD, adding `(objectCategory=person)` excludes computer accounts. Exactly one entry must match. |
| `FOLIO_LDAP_ADMIN_GROUP` | none | **required** | Group DN mapped to the `admin` role. First admin = first member. |
| `FOLIO_LDAP_USER_GROUP` | none | **required** | Group DN mapped to the `user` role. |
| `LDAP_CA_FILE` | system store | optional | Internal CA bundle for LDAPS verification. |
| `LDAP_ALLOW_INSECURE` | `false` | optional | Permit plain (unencrypted) LDAP. Off in production. |

## TTS

Optional until **M4** (see `docs/DECISIONS.md`): the M1–M2 stack boots without a TTS backend; these are validated when the TTS client is first constructed. Required in production from M4 on.

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `TTS_BASE_URL` | none | required from M4 | OpenAI-compatible base, e.g. `http://tts.example.local/v1`. |
| `TTS_API_KEY` | empty | optional | Bearer token, if the engine requires one. |
| `TTS_MODEL` | `tts` | optional | `model` field sent to the API; part of the audio cache key. |
| `TTS_FORMAT` | `opus` | optional | `opus` or `mp3`; falls back to `mp3` if the server rejects opus. |
| `TTS_DEFAULT_VOICE` | none | required from M4 | Last-resort voice, e.g. `ashley-en`. |
| `TTS_VOICE_MAP` | `{"en":"ashley-en","ja":"ashley-ja","ko":"ashley-kr","zh":"ashley-zh"}` | optional | Admin language → voice defaults; editable on the Admin page (M5). |
| `TTS_VOICES` | empty | optional | Comma-separated fallback list, used only if the engine can't list voices. |
| `TTS_VOICES_TTL` | `600` | optional | Seconds the discovered voice list is cached. |
| `TTS_VOICE_LANG_PATTERN` | `-(en\|ja\|kr\|ko\|zh)$` | optional | Language suffix matched from voice IDs; `kr` is treated as `ko`. |
| `TTS_MAX_CHARS` | `800` | optional | Max characters per TTS segment. |
| `TTS_REQUEST_CHARS` | `400` | optional | Longest single TTS request. Every sentence is its own request (sentences under 40 characters ride with the next) and the clips are joined, recording where each sentence starts for read-along; a sentence longer than this is cut at clauses. `0` sends each segment as one request. Segments already synthesized keep their clips; Reprocess a book to re-make its audio. |
| `TTS_LOOKAHEAD` | `6` | optional | Segments generated ahead of playback. |
| `TTS_CONCURRENCY` | `4` | optional | Most TTS requests in flight at once: a segment's sentences are synthesized this many at a time (VoxCPM2: 8 sentences took 6.0 s one by one, 2.1 s four at a time). Lower it for an engine that serves one request at a time. |
| `TTS_INSTRUCTIONS` | `true` | optional | Whether syntheses carry the narration prompt (the voice's instructions + the book's delivery note); set `false` for VoxCPM2. Only the default: Admin → Voices → Send style prompts overrides it once switched. Changing it re-generates audio as it is played. |
| `TTS_CHARS_PER_SECOND` | `15` | optional | Duration estimate before audio exists. |
| `TTS_SPEED_MIN` | `0.9` | optional | Lowest playback speed the engine supports; served by `GET /me/speed-options`. |
| `TTS_SPEED_MAX` | `1.15` | optional | Highest playback speed. |
| `TTS_SPEED_STEP` | `0.05` | optional | Playback-speed increment; the slider's positions are `MIN + n * STEP`. |

## Audio cache and metadata

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `AUDIO_CACHE_MAX_GB` | `50` | optional | Eviction threshold for `/data/audio` (LRU, never evicts active lookahead). |
| `METADATA_ONLINE` | `true` | optional | Enable Open Library / Google Books lookups (M3). |
| `GOOGLE_BOOKS_API_KEY` | empty | optional | Raises Google Books rate limits. A key set under Admin → Metadata wins over this one; without either, Google answers most lookups with 429. |

## Compose database (used by `compose.yaml` only)

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `POSTGRES_USER` | `folio` | optional | db service superuser; `DATABASE_URL` is derived from it in compose. |
| `POSTGRES_PASSWORD` | `folio` | optional | **Change in production.** |
| `POSTGRES_DB` | `folio` | optional | Main database name. |

## Test-only

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `FOLIO_TEST_MODE` | `false` | never in production | Mounts `POST /api/v1/test/login` for headless tests. Only `compose.test.yaml` may set it; `compose.yaml` must never. |
| `TEST_DATABASE_URL` | `postgresql+psycopg://folio:folio@localhost:5432/folio_test` | optional | Backend pytest target; created if missing. Never a dev or production database. |

## Set in the app (Admin → Metadata and Admin → AI)

These live in the database (`app_settings.integrations`), not the environment, so an admin can change them without a redeploy. Keys are never returned to a browser in full.

| Setting | Purpose |
|---|---|
| Google Books API key (Metadata) | Overrides `GOOGLE_BOOKS_API_KEY`. |
| Send style prompts (Voices) | Overrides `TTS_INSTRUCTIONS`. |
| Language model: base URL, API key, model | Any OpenAI-compatible `/chat/completions` endpoint (base URL ends in `/v1`); models are listed from `{base_url}/models`. Requests ask the model not to think unless "Let the model think" is on. |
| Reading model (OCR) | A vision model for scanned pages; empty uses the model. |
| Read scanned PDFs (OCR) | Scanned PDFs are read at import instead of stopping at `needs_ocr`. |
| Suggest pronunciation and a delivery note | A `suggest` job after each import proposes rules (applied only once accepted) and a delivery note. |
