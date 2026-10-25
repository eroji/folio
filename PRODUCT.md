# Product

<!-- impeccable:product-schema 1 -->

> Inferred from `docs/folio-application-spec.md`, `docs/MILESTONES.md` and `docs/DECISIONS.md`. **No interview was run** — anything below that sounds like a user quote is a summary of the written spec, not a confirmation. Correct it freely.

## Platform

web

## Users

Household members with LDAP/AD accounts, up to ~10, sharing one catalog — they are the primary audience, served equally (no "admin-first" bias). They mostly press Play and resume where they stopped, on phones and on desktop browsers in roughly equal measure; design is mobile-first per the spec but desktop ergonomics are first-class, not an afterthought. The administering user (Jimmy) is a secondary audience: uploads books, fixes metadata and covers, watches the job queue and TTS health.

## Product Purpose

Folio turns ebooks the household already owns (EPUB, PDF, Kindle) into a shared, self-hosted audiobook catalog. Speech is synthesized on demand by the household's own OpenAI-compatible TTS GPU and cached, so any book in the library is listenable with per-sentence progress that resumes on any device. Success means the household actually listens to its own ebook collection instead of it sitting unread; the app must be dependable enough that a non-technical family member needs no help.

## Positioning

Your own ebooks, narrated by your own TTS GPU — a private Audible with no per-book cost, no vendor lock-in, nothing leaving your network. Confirmed by the owner as the core claim a neighboring product could not copy.

## Operating Context

- Runs in an existing homelab: Docker/Podman Compose behind an nginx reverse proxy, images from an internal Harbor registry, PostgreSQL 16 and a `/data` volume.
- Sign-in is the household's Active Directory over LDAPS only; Folio stores no passwords; roles come from directory groups at every login.
- Narration comes from a Qwen3-TTS engine (verified homelab service) through the standard OpenAI `/v1/audio/speech` shape; voices are discovered live from the engine, never hard-coded.
- Metadata is enriched from Open Library and Google Books when enabled; a manual edit is never overwritten by a later automatic fetch.
- Listening rituals: mini player everywhere, lock-screen/headset controls, sleep timer, read-along text, speed control, chapter sheets.

## Capabilities and Constraints

- Formats: EPUB 2/3, PDF, MOBI/AZW/AZW3 via Calibre; DRM-protected and KFX files are rejected with a clear message; scanned PDFs are flagged `needs_ocr`, not failed.
- Playback: segment-level caching (one synthesis per segment per voice), gapless-feeling handoff, lookahead generation, shared-GPU concurrency cap.
- Progress: one row per user per book down to the sentence; last write wins; cross-device "continue from another device?" prompt when >60 s ahead.
- Scale ceiling: ~10 users, 5,000 books, 200 GB of cached audio.
- v1 non-goals (durable): DRM removal, OCR, hosting the TTS model, native apps, public sign-up, multi-tenancy, Redis, Web Audio graphs, component libraries.
- Status: milestones 1–5 accepted; M6 (PWA install, offline page, admin tools, metrics, accessibility pass, Finished shelf, `sort=progress`) is the remaining scope.
- Undecided product facts: bookmarks (spec allows v1.1), spoken chapter-title lead-ins (stored setting, currently inert), whether the cross-device prompt earns a manual two-browser verification.

## Brand Commitments

- Name "Folio" with a pinned identity: open-book mark in three-quarter view, blue→violet gradient (`#2381F7` → `#8B5CF6`), white play triangle; wordmark and headings in Outfit 600–700, body/UI in Inter 400–600; Lucide icons at 1.75 px stroke; no emoji.
- Logo assets exist and are binding: `frontend/public/logo.svg`, `logo-wordmark.svg`, icon set, manifest.
- Light and dark themes follow the system setting with an override; brand values live only in `frontend/src/styles/tokens.css`.
- Voice: plain, helpful, error messages that say what happened and what to do next (spec-pinned user-facing copy).

## Evidence on Hand

- Full application spec with pinned UI copy and brand values: `docs/folio-application-spec.md`.
- Accepted-milestone evidence (test counts, acceptance scripts, live-stack checks): `docs/MILESTONES.md`.
- Durable engineering/product decisions: `docs/DECISIONS.md`; TTS backend verification: `docs/TTS.md`.
- Seven generated public-domain fixture books (`make fixtures`); the real catalog is the household's own ebook collection.
- Absences future work must not fabricate: no testimonials, case studies, customer logos, benchmarks, pricing, or press — this is a private homelab app with no marketing surface.

## Product Principles

1. Listening is the product: play, resume, and progress are protected above every other feature.
2. Zero-help operation for listeners: any friction (bad metadata, DRM file, failed segment) is the admin's to fix, never the family member's to decode.
3. Private by architecture: the differentiator is that nothing leaves the network; no feature may quietly ship data out.
4. One shared catalog, one truth per book; each user's journey through it is their own.
5. Automatic work defers to human work: a hand-edited field is locked forever.

## Accessibility & Inclusion

- M6 acceptance requires Lighthouse accessibility ≥ 90 (pinned).
- Spec-pinned floor: 44 × 44 px touch targets, safe-area insets, full screen-reader labels on icon buttons, secondary text ≥ 4.5:1 contrast, keyboard control of the player (space/arrow keys), reduced-motion respected in read-along.
