# Folio — UI/UX Redesign Brief

**Hand this file (plus the referenced screenshots) to a designer or design agent.**
It is self-contained: product, current state, known problems, constraints, and deliverables. Functional scope is already built — this is a *design concept* engagement, not a greenfield product.

---

## 1. What Folio is

A self-hosted, private audiobook library for a household (≤ 10 people, ≤ 5,000 books). People upload EPUB/PDF/Kindle files; Folio extracts chapters, narrates them with the household's own TTS model, caches the audio, and remembers exactly where each person stopped. Sign-in is via the household's Active Directory.

**Positioning:** *your own ebooks, narrated by your own TTS GPU — a private Audible that never leaves the network.*

**Two equal contexts:**
- **Phone**, one-handed, often with the screen off or locked; start/resume fast, never lose the place.
- **Desktop browser**, reading along, fixing metadata, managing books.

**Two design modes:**
- **Operate** for the app (library, upload, book, settings, admin): scanability and one clear primary action.
- **Read** for the read-along: comfortable measure, book-like typography, zero chrome competing with the text.

## 2. Current stack and constraints

- React 19 + Vite + TypeScript + Tailwind 4 (CSS-first `@theme`, tokens in `frontend/src/styles/tokens.css`).
- No component library, no icon package beyond Lucide, no CDN fonts (self-hosted Outfit + Inter).
- Light and dark themes, system default with an override.
- Mobile-first at 390 px, works at 1440 px.
- Accessibility is a hard requirement: 44 px targets, visible focus, 4.5:1 contrast in both themes, reduced-motion support, keyboard/screen-reader labels.
- **Brand is pinned**: blue `#2381F7` → violet `#8B5CF6` gradient, periwinkle top page `#8EA2F9`, ink `#1E2235`, surfaces `#F6F7FB` / `#12141F`. Outfit 600–700 for display, Inter 400–600 for UI, serif for reading. Logo and icons are in `docs/sample/` and `frontend/public/`.
- Everything runs as one Docker image behind nginx; no external services at runtime beyond LDAP and the TTS API.

## 3. What exists today (routes)

| Route | Surface | Notes |
|---|---|---|
| `/login` | Sign-in | LDAP form; a test-mode panel appears only in the dev stack |
| `/` | Library | Continue-listening row, cover grid, search, sort, status filter, Finished shelf |
| `/upload` | Upload | Drag/drop, per-file progress, live processing status over SSE |
| `/books/:id` | Book | Cover with play overlay + percent, chapter select, narrator voice, Book settings (chapters + pronunciation), actions |
| `/books/:id/edit` | Metadata editor | All fields, cover editor with 2:3 crop, Find metadata |
| `/player?book=` | Player | Cover, chapter select, scrubber, transport, speed/sleep/read-along/voice, page-like read-along |
| — | Mini player | Plex-style bar: cover with percent, elapsed/total, prev/back/play/forward/next/stop |
| `/settings` | Settings | Theme, speed, skip intervals, auto-play, per-language voices with preview |
| `/admin` | Admin | Job queue with retry, TTS health, audio cache size/clear, users |

**Current screenshots:** `docs/screenshots/current-phone-*.png`, `current-desktop-*.png` (library, book, player, mini player, settings).

## 4. What testers said (the honest problem list)

- The UI flow into a book is awkward; controls are scattered and the primary action competes with secondary ones.
- The desktop player still reads like a centered phone app; the read-along is better but the overall layout is not desktop-native.
- The book page tries to do everything at once: metadata, narrator, chapters, settings, actions.
- Voice selection and per-book settings are functional but feel like configuration panels bolted on.
- The library works but is visually flat; hierarchy between "continue listening", catalog, and finished is weak.
- The mini player is now Plex-like but the rest of the player doesn't share that visual language.
- Navigation is a header + fixed bottom tabs; on desktop it leaves a lot of unused space.

## 5. Design brief

**Goals**
1. Make "resume the book I was listening to" a two-second, zero-thought action on phone and desktop.
2. Give the book page a clear hierarchy: *what is this book* → *play it* → *manage it* (collapsed).
3. Make the player feel like a media player on desktop and a reading surface on mobile — one coherent language, not two apps.
4. Make the read-along feel like a book page regardless of viewport.
5. Keep admin/metadata powerful but out of the listener's way.

**Non-goals**
- No new product features, no backend/API changes, no new data model.
- No dark-pattern marketing surface; this is a private tool.
- Do not replace the logo or brand palette; evolve how they are used.

**Questions the concept must answer**
1. Navigation: keep top bar + bottom tabs, or a desktop sidebar + mobile bottom bar? How does "now playing" relate to navigation?
2. Book detail: single scroll page vs hero + tabs vs split layout? Where do metadata, chapters, settings and destructive actions live?
3. Player: one layout that adapts, or distinct phone and desktop compositions? Where does the read-along sit on desktop (side panel, page, overlay)?
4. Library: how do Continue listening, catalog, and Finished coexist without three competing banners?
5. Mini player: how much control on phone vs desktop, and how does it expand into the full player?

**Tone**
Quiet, confident, bookish without skeuomorphism. Brand gradient used sparingly (primary action, progress, mark) — not as decoration. Type carries the personality; spacing does the hierarchy work.

## 6. Deliverables (what to hand back)

1. **2–3 concept directions** as low-fidelity wireframes first (phone + desktop), each with a one-line point of view and trade-offs.
2. After a direction is chosen: **hi-fi screens** for:
   - Login, Library (empty + populated + finished), Upload, Book detail, Edit metadata, Find metadata, Player (phone + desktop, with and without read-along), Mini player (phone + desktop), Settings, Admin.
   - Light and dark for the key screens.
   - States: loading/skeleton, empty, error, offline, first-run, no-voices, needs-OCR book, failed job.
3. **Component + token spec**: spacing scale, type scale, radii, shadows, color roles, focus/hover/pressed/disabled, player controls, book card, chapter selector, table (pronunciation), dialog, toast/inline error.
4. **Motion notes**: transitions (150–250 ms), page/panel transitions, mini→full player, read-along auto-scroll, reduced-motion equivalents.
5. **Responsive rules** at 390 / 768 / 1024 / 1440 and landscape.
6. **Accessibility annotations** per screen: focus order, labels, live regions, contrast pairs.
7. **Handoff format:** Figma (preferred) or a clickable HTML prototype, plus a single page mapping each design decision to the existing component/file it replaces.

## 7. Functional contract (must survive the redesign)

- Auth: LDAP login, session cookie, CSRF header on mutations; roles admin/user.
- Library: search, sort (recent/title/author/progress), status filter, paging, Continue listening, Finished.
- Upload: multiple files, per-file progress, live SSE status, duplicate → link to existing.
- Book: metadata edit + locked fields, Find metadata + apply, cover upload/URL/2:3 crop, chapter inclusion, per-book pronunciation rules, reprocess, delete.
- Player: segment-based streaming, lookahead, gapless handoff, chapter navigation, speed 0.75–2.5, sleep timer, read-along with sentence highlight + auto-scroll, Media Session, progress save/resume, cross-device prompt, mark finished/reset.
- Voices: discovered from the TTS engine, language-filtered, previews.
- Admin: jobs + retry, TTS health, cache size/clear, users.
- PWA: installable, offline page, cached shell/covers, audio never cached.

**Do not break:** only one audio element may play at a time; the reader must scroll internally, never push the page; sticky bars must not cover content; every mutation needs CSRF; no raw HTML from providers.

## 8. Technical handoff constraints

- Keep the route structure unless the concept requires a change (call it out explicitly).
- Tailwind 4 + CSS variables; no new runtime dependencies without a one-line justification.
- Components live in `frontend/src/components`, pages in `frontend/src/pages`; keep files focused.
- Tokens must map to `tokens.css` (`--brand-*`, surfaces, `--font-reading`).
- Icons: Lucide, 1.75 px stroke, sizes 18/20/22/28.
- The app is maintained by a small team: prefer boring, legible patterns over bespoke interactions.

## 9. Acceptance of the concept

- A first-time listener can go from app open to audio in **two taps/clicks**.
- A book's primary action is unambiguous on every viewport.
- The read-along at 1440 px looks like a page, not a chat transcript; the window never scrolls while reading.
- All screens pass WCAG AA contrast, keyboard-only use, and 200% zoom without loss.
- The concept survives 390 px and 1440 px, light and dark, with realistic long titles/authors and a 5,000-book library.

## 10. Reference files

- Product context: `PRODUCT.md`
- Current design contract: `DESIGN.md`
- Full application spec: `docs/folio-application-spec.md`
- Decisions and gaps: `docs/DECISIONS.md`, `docs/MILESTONES.md`
- Brand assets: `docs/sample/*.svg`, `frontend/public/`
- Current UI: `docs/screenshots/current-*.png`
