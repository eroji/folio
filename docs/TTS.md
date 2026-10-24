# TTS backend contract (verified 2026-10-24)

Probed the homelab service so M4 is built against reality, not the spec's assumptions.

**Endpoint:** `http://vllm.dotslash.io:8880` — Qwen3 Voice Studio (`qwen3-tts-openai` 0.1.0).

| Probe | Result |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /v1/models` | `200 {"object":"list","data":[{"id":"qwen3-tts",...}]}` |
| `GET /v1/audio/voices` | `200 {"voices":["tts","ashley-zh","ashley-ja","ashley-kr","ashley-en"],"uploaded_voices":[{"name":"ashley-zh","description":""},...]}` |
| `GET /v1/voices` | `404` (so the spec's fallback order is correct) |
| `POST /v1/audio/speech` `{"model":"tts","voice":"ashley-en","input":"Hello from Folio.","response_format":"opus","speed":1.0}` | `200 audio/opus`, 10.7 KB Ogg/Opus, mono 24 kHz, 0.32 s |

## Consequences for the M4 client

- Set `TTS_BASE_URL=http://vllm.dotslash.io:8880/v1`; `TTS_MODEL=tts` is accepted as-is; `TTS_DEFAULT_VOICE=ashley-en`.
- Voice discovery: the first endpoint answers, and the body has **both** `voices` (array of strings) and `uploaded_voices` (array of objects). Parse `voices`, and merge `uploaded_voices[].name`/`description` when present — the description is worth showing next to a preview.
- The list contains `"tts"` alongside the `ashley-*` voices. It has no language suffix, so the language pattern must treat it as "any language" and it must not be selected automatically for `en`.
- No `language` field is sent per voice; language comes from the ID suffix (`-(en|ja|kr|ko|zh)$`), with `kr` mapped to `ko`. This matches the spec's default pattern exactly.
- Opus in Ogg is returned directly, so the spec's `TTS_FORMAT=opus` default needs no fallback here; keep the mp3 fallback for portability.
- `/v1/audio/speech` takes no auth here (`TTS_API_KEY` empty).
- A 3-word utterance generated in 0.32 s, so lookahead of 6 segments is comfortably ahead of playback at 1×(~15 chars/s).

## For the admin health check (M4)

`GET /health` on the TTS base host (strip `/v1`) is a cheap liveness probe and should feed `GET /api/v1/admin/health`'s `tts` field, replacing the current `"not_configured"` placeholder.

## Note on voice names

`ashley-kr` is the engine's Korean voice despite the non-standard `kr` suffix; the spec's mapping (`kr` → `ko`) is required, not cosmetic.
