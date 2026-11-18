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
- `POST /v1/audio/speech` accepts an optional **`instructions`** string. Folio sends the admin's per-voice prompt plus `You're narrating a {genre} novel.` for the book's genre; the field is omitted when there is nothing to say, and the instruction is part of the audio cache key.

## For the admin health check (M4)

`GET /health` on the TTS base host (strip `/v1`) is a cheap liveness probe and should feed `GET /api/v1/admin/health`'s `tts` field, replacing the current `"not_configured"` placeholder.

## Note on voice names

`ashley-kr` is the engine's Korean voice despite the non-standard `kr` suffix; the spec's mapping (`kr` → `ko`) is required, not cosmetic.

## VoxCPM2 (`voxcpm2-openai`, measured 2026-11-08)

`http://vllm.dotslash.io:8881/v1`, model `voxcpm2`, voices are the Studio library keys (e.g. `tess`). The server is deterministic: the same request returns byte-identical audio.

When a request carries `instructions`, voxcpm2-openai prefixes them as `(style)text` and **drops the voice's reference transcript** (VoxCPM2 "controllable cloning"). Without instructions it clones with the transcript. One 746-char segment, voice `tess`, across seeds:

| Spread across seeds | with Folio's prompt (7 clips) | without (6 clips) |
| --- | --- | --- |
| median pitch | 210–242 Hz (≈2.4 semitones) | 216–225 Hz (≈0.7 semitones) |
| loudness | −15.3 to −18.8 dBFS | −17.7 to −18.3 dBFS |
| duration | 31–40 s | 32.5–36.8 s |

Different segments behave like different seeds, so with a prompt the narrator's pitch, level and pace jump at segment boundaries. Head-vs-tail drift inside a clip was small either way, so segment length is not the cause. **Set `TTS_INSTRUCTIONS=false` for VoxCPM2.** Changing it changes every cache key, so clips re-synthesize on demand.

## AAC and the HLS book stream

`TTS_FORMAT=aac` asks the engine for AAC-LC in ADTS framing (voxcpm2-openai ≥ 0.3.16, Q-028). Folio counts ADTS frames for exact clip durations and, on Safari/iOS, plays a book as one HLS stream built from those clips (see the spec, "Gapless-feeling playback"). The interaction with the engine is otherwise unchanged: one `/v1/audio/speech` request per segment, same queue and cache, only `response_format` differs. Switching the format re-keys every clip, so they re-synthesize on demand.

## Requests per segment (`TTS_REQUEST_CHARS`, 2026-11-17)

A segment (up to `TTS_MAX_CHARS` = 800 characters, about 50 s of audio) used to be one `/v1/audio/speech` request. With a cloned voice the later sentences of such a clip audibly lost likeness and picked up artifacts: one long autoregressive generation drifts away from the reference (the 2026-11-08 numbers above measured pitch and loudness, not timbre). Folio now sends a segment longer than `TTS_REQUEST_CHARS` (default 300) as several requests of whole sentences, one after another, and joins the clips into the segment's one cached file: ADTS and MP3 frames are concatenated (ID3 tags and Xing/Info frames dropped), Ogg Opus is re-muxed into one logical stream with recomputed granules and CRCs. Stored segments, read-along and progress are unchanged; split segments get a new cache key (`|req=N`). A segment that is already ready on a clip made as one request keeps it (re-queueing ready segments broke iOS streams in v0.1.14, see DECISIONS); only audio synthesized from now on is split. To re-make a book's audio with split requests, Reprocess it.

### One sentence per request, with marks (v0.1.16)

~300-character requests still degraded in their later sentences with a cloned voice, so every sentence is now its own request (a sentence under 40 characters rides with the next; one over `TTS_REQUEST_CHARS` = 400 is cut at clauses). The joined clip stores `marks`: for each request, the fraction of the segment's text it starts at and the second it starts in the clip (exact ADTS/MP3 frame counts, Opus decoded samples). `POST /books/{id}/audio/prepare` returns them and read-along interpolates within sentences instead of assuming an even pace over the whole segment. `audio.text_key` identifies what was said regardless of the split, so a ready segment keeps its clip when only the split changes (clips from v0.1.14/0.1.15 are recognized by their `|req=300` key).
