# Folio UX Iteration 2 (Reader, Pronunciation, Player) Plan

> For agentic workers: superpowers:subagent-driven-development. Steps are checkboxes.

**Goal:** Make listening/reading feel like a book and a real media player, and give each book a settings surface for pronunciation and chapter inclusion.

**Spec:** `docs/folio-application-spec.md` (Player, TTS text preparation, Screens 4/6/7). **Design contract:** `DESIGN.md` + `PRODUCT.md`.

## Global constraints

- Brand tokens unchanged (blue/violet, Outfit/Inter). Reading text adds a **serif** stack (`ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif`) via `--font-reading`.
- No new runtime dependency (system serif; no font package).
- Server enforces admin-or-uploader on book settings; CSRF on mutations; error envelope.
- TTS cache correctness: any changed pronunciation rule must change the cache key or invalidate the book's audio.
- 44 px targets, visible focus, 4.5:1 both themes, reduced motion.

## Workstreams

### A. Pronunciation rules + voice policy (backend) — `feat/pronunciation`
- Migration `0007`: `pronunciation_rules(id, book_id FK cascade, match, say, whole_word bool, after_number bool, case_sensitive bool, created_at)`.
- Endpoints under `/api/v1/books/{id}/pronunciation`: `GET` list, `POST` create, `PATCH /{rule_id}`, `DELETE /{rule_id}` (admin/uploader, CSRF, validation: non-empty, ≤200 chars, case-insensitive duplicate match rejected).
- `apply_rules(text, rules)` in `folio/tts/pronunciation.py`: whole-word (`\b`), after-a-number (`(?<=\d\s?)`), case sensitivity. Rules applied **before** `normalize_speech_text`, in list order, on segment text.
- `tts/queue.py`: load the book's rules in `prepare` and `run_tts_job`; cache key and synthesis input use the corrected text. On any rule change, delete that book's `segment_audio` rows and notify (next play regenerates); leave old audio files to eviction.
- Voice policy: `GET /voices` omits the `tts` fallback voice; `select_voice` falls back to the **first discovered voice for the language** (then config map, then TTS_DEFAULT_VOICE). Tests incl. `ashley-kr`→ko, `tts` hidden, first-for-language fallback.

### B. Book-like reader + Plex mini player (frontend) — `feat/reader-book`
Files: `components/{FullPlayer,ReadAlong,MiniPlayer}.tsx`, `player/PlayerProvider.tsx`, `components/AppShell.tsx`, `styles/tokens.css`.
- **Reader box (desktop):** a bordered page panel (`rounded-card`, `border-line`, subtle paper surface), own internal scrollbar (`max-height: calc(100dvh - 20rem)`), serif `--font-reading`, 68ch measure, generous leading. Auto-scroll must move the **panel's** `scrollTop` (not the window). Keep sentence highlight + A−/A+.
- **Chapter selector:** full-width styled `<select>` (native) with previous/next chapter arrow buttons on either side, replacing the chapter sheet/accordion pattern in the player. Options: `idx+1 · title`.
- **Mini player (Plex-like):** cover 56px with a **progress percent badge overlaid bottom-left**; title, chapter, `elapsed / total` time; controls: previous chapter, back `skip_back`, play/pause, forward `skip_forward`, next chapter, stop (unload); desktop also speed. Hide the extra controls under 480px. No banner above it.
- `PlayerProvider`: add `stop()` (pause both, clear book/URL), expose `chapterElapsed`/`chapterTotal`; keep single-element playback guarantees.
- Remove the "big progress pane" above the mini player on the book page (handled by C).

### C. Book page + book settings + reset confirm (frontend) — `feat/book-settings`
Files: `pages/BookDetailPage.tsx`, `components/{BookSettings,PronunciationRules,ResetProgressDialog}.tsx`, `api/books.ts`, tests.
- Remove the fixed bottom Play/progress bar. Cover gets a **play overlay** and a **percent badge bottom-left**; the mini player is the persistent control.
- **Book settings** disclosure (admin/uploader only) containing: chapter inclusion switches (existing endpoint), and **Pronunciation rules** table exactly like the reference: columns `Match`, `Say`, `Whole word`, `After a number`, `Case-sensitive`, remove `×`; add-row control; delete confirms nothing (instant); inline validation.
- **Reset progress** opens a confirmation dialog; on confirm `DELETE /books/{id}/progress`, clear `folio-pos-<id>`, and start the player from the beginning (`/player?book=<id>&chapter=<first>`).
- Chapter dropdown on the book page: a native select styled like the player's, plus prev/next arrows; no accordion.

### D. Voice picker cleanup (frontend) — `feat/voices-cleanup`
Files: `components/VoicePicker.tsx`, `pages/SettingsPage.tsx`, `pages/BookDetailPage.tsx` (only the narrator section), tests.
- Remove the **Default** option and **Show all voices** toggle.
- List only voices whose language matches the book/language (with `zh-TW` → `zh`), never `tts`.
- When nothing is saved, display the first available voice for that language (no write until the user changes it); the backend fallback already picks it.
- Settings: per-language pickers keep Preview; no "Default"; refresh stays.

## Acceptance
- `make test`, `make lint`, `npm test`, `tsc`, `build`, Playwright.
- Live: reader panel has its own scrollbar and serif text at 1440px; chapter select + arrows switch chapters; mini player matches the Plex layout and overlays percent on the cover; reset asks first and restarts at the beginning; pronunciation rule (`nginx` → `engine X`, whole word) audibly changes the synthesis (verify cache key changes and the worker re-synthesizes); voices dropdown shows only language voices and no `tts`.
