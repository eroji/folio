# Folio UI redesign, Direction D ("Ribbon") — implementation handoff

**This document replaces the earlier Direction C handoff (`folio-ui-handoff`) completely.** The current build partly follows Direction C (icon rail on the left, avatar at the bottom of the rail, Now Playing side panel, Plus Jakarta Sans and Newsreader, blue-violet brand, light and dark themes). Direction D is a different look and a different app layout, modelled on the structure of YouTube Music: dark only, black background, one warm accent color, a labelled sidebar, a full-width player bar at the bottom and an expanded "Now playing" page.

Where anything in the old handoff, `DESIGN.md` or earlier decisions disagrees with this file, **this file wins**.

The backend stays as it is except for the few data changes listed under "Data and API changes".

---

## How to work

1. Read this file end to end, then look at `screenshots/` (or open the matching files in `reference/` in a browser). Each reference file names its screen in a comment at the top.
2. Work one phase at a time (see "Implementation plan"). After each phase run `npm run lint`, `npx tsc --noEmit` and the existing tests, then **stop and report** before the next phase.
3. Take every color, radius and font from `frontend/src/styles/tokens.css`, never from the inline styles in the reference files.
4. Do not invent layouts for screens that are not designed (listed under "Not designed"). Restyle them with the new tokens and components only.
5. Record every deviation and every judgement call in `docs/DECISIONS.md`.
6. The functional contract in `UI-REDESIGN-BRIEF.md` §7 still applies (one audio element, CSRF on every mutation, progress save and resume, Media Session, SSE upload status, no raw provider HTML). Nothing in this redesign removes a backend capability.

## What is in this package

| Path | What it is |
| --- | --- |
| `HANDOFF.md` | This spec |
| `frontend/src/styles/tokens.css` | Drop-in replacement for the existing tokens file (Tailwind 4, dark only) |
| `brand/web/` | Favicon (ICO and SVG), Apple touch icon, PWA icons (192, 512, maskable 512), `site.webmanifest`, `head-snippet.html` → copy into `frontend/public/` and `index.html` |
| `brand/svg/` | `folio-mark.svg` (bookmark mark, in-app logo), `folio-mark-mono.svg` (`currentColor`), `folio-logo.svg` (mark + "folio" for dark backgrounds), `folio-logo-on-light.svg`, `folio-wordmark.svg` (`currentColor`), `app-icon.svg` |
| `brand/png/` | 1024 px mark and app icon, 1200 px logo, favicon PNGs |
| `reference/desktop-*.html` | Desktop screens: home, library, book, book menu, book manage, edit details drawer, player, search, upload, settings (playback, voices), account menu, admin voices, login |
| `reference/phone-*.html` | Phone screens: home, book, player, read along |
| `screenshots/*.png` | A PNG of every reference file (same names), rendered with the real fonts: desktop at 1440 px wide (full page), phone at 390 × 844 (2×). Use these when you can't open the HTML; if a screenshot and this document disagree, this document wins |

---

## 1. What changes from the current build

### Remove

| Remove | Why / what replaces it |
| --- | --- |
| Light mode, the theme setting, `data-theme` switching, the System/Light/Dark control in the account menu and the Appearance section in Settings | The app is dark only. Set `color-scheme: dark` once. Delete the user setting and any code that reads it. |
| The 60 px icon rail and the avatar at the bottom of the rail | Replaced by a labelled sidebar (desktop) and an avatar in the top bar |
| The Now Playing **side panel**, its 50/50 split, its collapse-to-bar state and the resizable-split idea | Replaced by the full-width **player bar** at the bottom plus the **expanded Now playing page** |
| Desktop **focus mode** | Replaced by the expanded Now playing page (Read along tab) |
| The cover **percentage badge** (dark tag with "38%") | Replaced by a thin accent progress bar along the bottom edge of the cover, and a round accent check in the corner for finished books |
| Every narrator **voice button** outside the book's ⋮ menu: in the player bar, in the side panel, beside Resume on the book page, on the phone player | The per-book narrator is changed only from the book page ⋮ menu ("Narrator voice…"). The per-language defaults stay in Settings → Voices. |
| Plus Jakarta Sans, Newsreader, Outfit, Inter and their Fontsource packages | Sora (display) and Figtree (everything else) |
| The blue-violet gradient, periwinkle and every brand color from Direction C, including `bg-primary-gradient` | Black surfaces, white primary buttons, one accent (Amber `#FFC233`) |
| The open-book "box" logo and all its icon files | The bookmark-ribbon mark in `brand/` |
| `@material-symbols/svg-400` and the Material Symbols icon pipeline | `lucide-react` (see the icon table) |
| The "⋯" listener menu items "Download for offline" (already removed) | — |
| The full-page "Edit metadata" view, the separate Cover row in Manage, and the "Narrator voice override" field | The **Edit details drawer** (cover included); the narrator is set only from the book's ⋮ menu |

### Replace (same function, new form)

| Before | After |
| --- | --- |
| Gradient primary button | **White pill** (`--color-fg` fill, `--color-on-fg` text, 700 weight) |
| Selected states in blue | Selected chip: **accent fill, dark text**. Selected nav item / tab: raised fill or white pill (see components) |
| Square-ish controls (6–8 px radius) | **Pills** for every button, chip, input, select, switch and icon button; 10–20 px radius for cards, rows, menus |
| Library at `/` | **Home** at `/`; **Library** at `/library` (route change) |
| Search as a focused field on the library | **Search** page at `/search?q=` (route change) |
| Book page hero + tabs below | Two columns: **book column on the left, tabs and content on the right** (album-page layout) |
| Native select arrows | Native arrow hidden; a chevron icon 16 px from the right edge (`.select-pill` + absolutely positioned icon) |
| Visible scrollbars in phone scroll areas | Hidden; swipe to scroll (`.no-scrollbar`), read-along edges fade (`.fade-edges`) |

### Add

| Add | Where |
| --- | --- |
| **Home** page with shelves: Continue listening, Next chapters, Recently added | `/` |
| **Group by** in the Library (default **Genre**) with genre shelves | `/library` |
| A **Genre** field on books | Data change, About tab, Edit details |
| **Expanded Now playing** page with UP NEXT / READ ALONG / ABOUT tabs | `/player` (the existing route, new layout) |
| Lyrics-style read-along (past sentences dim, current sentence large and bright) | Player page, phone Read along |
| **Glow**: an accent tint at the top of the main pane; on the book page and player, a tint from the book's cover color | Main pane only |
| Sidebar "In progress" list and "Add books" pill | Desktop sidebar |
| Filter chips on Home and Library (status, language, "Under 3 hours") | Home, Library |
| Phone bottom navigation (Home, Library, Search, Upload) and a phone mini player | Under 768 px |

---

## 2. Foundations

### Color (all in `tokens.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#0B0B0C` | App and sidebar background |
| `--color-surface` | `#151517` | Player bar, cards (top result, upload rows) |
| `--color-raised` | `#202023` | Chips, inputs, selects, selected nav item, menus, current chapter row |
| `--color-border` | `#2E2E33` | Dividers, outlines of secondary buttons, progress track |
| `--color-fg` | `#F7F7F2` | Text; fill of primary (white) buttons and of the play/pause button |
| `--color-fg-2` | `#A9A9B0` | Secondary text (8.4:1 on bg) |
| `--color-on-fg` | `#0B0B0C` | Text and icons on white buttons and on accent fills |
| `--color-accent` | `#FFC233` | Progress fills, selected filter chip, avatar, logo, "playing" icon, focus ring |
| `--color-danger` / `--color-success` / `--color-warning` | `#FF7A7A` / `#5BD69B` / `#FFC233` | Delete and failed; ready and finished statuses; needs-OCR |

Rules:
- **Accent is never used for body text**, only for fills, icons and progress. Anything sitting on an accent fill uses `--color-on-fg`.
- **Primary actions are white pills**, not accent: Resume/Play, Choose files, Sign in, Play (search result), and the play/pause buttons.
- **Glow** only on the main pane, never on the sidebar or the player bar:
  - default pages: `.bg-page-glow` (accent at 16% fading out by about 520 px);
  - book page: `.bg-cover-glow` with `--cover-rgb` set from the book's dominant cover color (55%);
  - player page and phone player: `.bg-cover-glow-strong` (85%).
  - Compute the dominant color once when the cover is stored (server: average of the cover after a small resize; save as `cover_rgb`), fall back to the accent glow when unknown.

### Type

- **Sora 700** (`.font-display`, letter-spacing −0.03em) for page titles (42 px), shelf titles (30 px), section titles (24 px), the book title (36 px desktop, 24 px phone) and the player title (30 px / 24 px phone). Lowercase "folio" in the logo is Sora too.
- **Figtree 400–700** for everything else, including the read-along text (22 px, 600 weight, line-height 1.55; current sentence 26 px; phone 21 / 25).
- Eyebrows (small labels above titles, e.g. the user's display name above "Continue listening", "128 books" above "Library"): 12 px, 600, uppercase, 0.08em tracking, secondary color.
- Times and percentages use tabular numbers.
- CJK book text: set `lang` from the book's language; the fallback stacks are in `tokens.css`.

### Shape and size

- **Pills (999px)** for every button with text, chips, the search field, selects, steppers, switches, the avatar and every icon button.
- Radii: covers in grids 10 px; small list covers 4 px; list rows and menus 12 px; sidebar items and upload rows 14 px; drop zone and top-result card 20 px; book-page cover 12 px; player cover 14 px.
- Heights: primary pill 48 px on the book page, 40 px elsewhere; chips 34 px; icon buttons 40 px (36 px for carousel arrows, 44 px on phone); sidebar items 48 px; player bar 72 px; phone bottom nav 64 px; phone mini player 64 px.
- Touch targets: 44 px minimum on phone. Desktop controls are 36–40 px.

### Icons: `lucide-react`, stroke width 2

Use `fill="currentColor"` (and `strokeWidth={0}` where needed) for the four transport icons, which are drawn filled. Lucide renames icons occasionally; if a name below doesn't exist in the installed version, use its current name from lucide.dev (the old names usually remain as aliases).

| Use | Lucide icon |
| --- | --- |
| Home / Library / Search / Upload | `House` / `LibraryBig` / `Search` / `Upload` |
| Sidebar collapse | `Menu` |
| Add books | `Plus` |
| Play / Pause (filled) | `Play` / `Pause` |
| Previous / next chapter (filled) | `SkipBack` / `SkipForward` |
| Back 15 s / forward 30 s | `RotateCcw` / `RotateCw` (label carries the seconds) |
| Speed | `Gauge` |
| Sleep timer | `Moon` |
| Narrator voice (⋮ menu item only) | `Speech` |
| Open / close player | `ChevronUp` / `ChevronDown` |
| Stop and close player | `X` |
| More | `EllipsisVertical` |
| Carousel | `ChevronLeft` / `ChevronRight` |
| Played chapter, finished | `Check` |
| Currently playing chapter | `AudioLines` (accent) |
| Mark as finished / Reset progress / Go to author | `CircleCheck` / `RotateCcw` / `User` |
| Edit details / Find metadata / Change cover | `Pencil` / `Globe` / `Image` |
| Reprocess / Refresh voices | `RefreshCw` |
| Delete | `Trash2` |
| Settings / Admin / Sign out | `Settings` / `Shield` / `LogOut` |
| Grid view / List view | `LayoutGrid` / `List` |
| Text size (read along) | `AlignLeft` |
| Auto-scroll (read along) | `ChevronsDown` |
| Show password | `Eye` / `EyeOff` |
| Locked field (Edit details) | `Lock` |
| Reorder handle | `GripVertical` |
| Paste link (cover) | `Link` |
| Needs OCR / failed | `TriangleAlert` |
| Ready | `CircleCheck` |
| Processing | `RefreshCw` (spinning; static with reduced motion) |

### Motion

150–250 ms ease-out for menus, tab changes and hover fills. The expanded player opens by sliding up from the player bar (250 ms) and closes by sliding down. Reduced motion: no slides, instant changes.

---

## 3. App shell

### Desktop (1024 px and up)

Three regions: **sidebar** (left), **main pane** (scrolls), **player bar** (bottom, full width, only when a book is loaded).

**Sidebar** (232–248 px, `--color-bg`, 1 px right border):
1. A 56 px row: `Menu` icon button (collapses the sidebar to a 72 px icon-only rail, remembered in localStorage) and the logo (`folio-mark.svg` 29 px tall + "folio" in Sora 23 px; links to Home).
2. Nav items (48 px, 14 px radius, 24 px icons, 16 px labels): **Home, Library, Search, Upload**. The current page has `--color-raised` fill and 700 weight, `aria-current="page"`.
3. Divider, then an **"Add books"** pill (40 px, raised fill, `Plus`) that goes to Upload.
4. An **"In progress"** eyebrow and up to 4 of the user's in-progress books, most recently played first: title (14 px, 600, one line) and "38% · Chapter 3" (12 px, secondary). Clicking one opens its book page.
- There is **no Settings or Admin item** in the sidebar; they are in the account menu.

**Main pane**: padding 12 px 40 px 48 px; 32 px gap between blocks; glow background as above.

**Top bar** (56 px, inside the main pane, on every page):
- Search field: pill, 44 px tall, up to 520 px wide, raised fill, `Search` icon inside on the left, placeholder "Search books, authors, series". Typing and Enter go to `/search?q=`. On the Search page it has a 2 px accent border and a clear (`X`) button.
- Avatar (36 px circle, accent fill, the user's initial in `--color-on-fg`) on the right. It opens the **account menu**.

**Account menu** (drops below the avatar, right-aligned, raised fill, 12 px radius, menu shadow):
- Header: 40 px avatar, display name (15 px, 700), "@username · Admin" (13 px, secondary; "· Admin" only for admins).
- Divider, **Settings**, **Admin** (admins only), divider, **Sign out**.
- Nothing else: no theme control.
- `aria-haspopup="menu"`, `aria-expanded`, arrow keys, Esc closes and returns focus.

**Player bar** (72 px min, `--color-surface`, 1 px top border, a 3 px progress line along its top edge in accent over `--color-border`):
- Left: previous chapter, back 15 s, **play/pause** (48 px white circle, dark icon), forward 30 s, next chapter, then "8:12 / 12:40" (13 px, secondary, tabular).
- Middle: 32 px cover, chapter title (15 px, 600) and "Book title · Author" (13 px, secondary, ellipsis). The whole block is a link that opens the expanded player.
- Right: speed as a text button ("1.25×", cycles 0.75→2.5 or opens a small menu), sleep timer (`Moon`; a small countdown badge when set), **stop and close** (`X`, secondary color), and **open player** (`ChevronUp`; becomes `ChevronDown` "Close player" on the player page).
- **No narrator voice button.**

**Player visibility rules** (carried over unchanged from the old handoff, applied to the bar):
- The bar shows whenever a book is **loaded**, playing or paused. It never appears or disappears on play/pause.
- On app start, load the most recently played book, paused at its saved position, so Resume is one click away anywhere.
- Close (`X`) stops playback, saves progress and unloads the book; the bar disappears until the user plays something.
- If the loaded book was last played on another device, show it paused at the synced position and replace the bar's subtitle line with "Paused · last played on {device} {time ago}". Never start a second player automatically.
- Only one `<audio>` element exists app-wide; the bar, the expanded player, the phone mini player and the phone player all drive the same player state.

### Tablet (768–1023 px)

The sidebar starts collapsed to the 72 px icon-only rail (icons with 11 px labels underneath), the "In progress" list is hidden, everything else as desktop.

### Phone (under 768 px)

- No sidebar. **Header** (56 px): logo on the left; `Search` icon button and the avatar (32 px) on the right.
- **Bottom navigation** (64 px, `--color-surface`): Home, Library, Search, Upload; 24 px icons with 11 px labels; current item in `--color-fg` and 700, others secondary.
- **Mini player** (64 px, raised fill) directly above the bottom nav while a book is loaded: a 2 px accent progress line on top, 32 px cover, chapter title and book title, back 15 s, play/pause. Tapping the cover or titles opens the phone player.
- Scroll areas hide their scrollbars (`.no-scrollbar`).
- Respect safe areas when installed as a PWA (`viewport-fit=cover`, `env(safe-area-inset-*)` padding on the header, mini player and bottom nav).

---

## 4. Screens

### Home (`/`) — `reference/desktop-home.html`, `reference/phone-home.html`

1. **Filter chips**: All (selected by default), In progress, Not started, Finished, then one chip per language present in the library (English, 日本語, 한국어, 中文…), then "Under 3 hours". Selected chip: accent fill, dark text, 700. Chips filter the shelves below.
2. **Continue listening**: eyebrow = the user's display name; title "Continue listening"; carousel arrows (36 px outlined circles) on the right. A horizontal row of 176 px cover cards: cover with the accent progress bar along its bottom edge, title (15 px, 600), "Ch. 3 · 2 h 36 m left" (14 px, secondary). Clicking a card **resumes playback** of that book and opens nothing else; the title link opens the book page.
3. **Next chapters**: title plus a "Play next" outlined pill. A 3-column grid (`repeat(auto-fill, minmax(280px, 1fr))`) of rows: 36 px cover, the next chapter's number and title (15 px, 600), "Book title · 18 min" (secondary). One row per in-progress book, its next unplayed chapter. Clicking a row starts that chapter; "Play next" starts the first row.
4. **Recently added**: title, "See all" pill (goes to `/library?sort=recent&group=none`), a row of cover cards with "Author · length"; finished books show the round accent check.
- **Empty home** (no books): a centered message "Your library is empty" and a white "Upload books" pill.

Phone: chips (scroll sideways), a 140 px card carousel for Continue listening, and the first three Next chapters rows.

### Library (`/library`) — `reference/desktop-library.html`

- Eyebrow "128 books" (the total), title "Library".
- Right side: **Group by** select (None, **Genre** (default), Author, Language, Status), **Sort** select (Recently added, Recently played, Title, Author, Progress), and a Grid/List switch (two icon pills in a raised track). All three are remembered per user in localStorage.
- Filter chips with counts: All, In progress, Not started, Finished, **Needs attention** (needs OCR or failed processing), then languages.
- **Grouped by Genre**: one shelf per genre, sorted by number of books (largest first), then "No genre yet" last. Each shelf: genre name (Sora 24 px) with its count beside it (Figtree 15 px, secondary), "See all" (goes to `/library?genre=<g>&group=none`), carousel arrows when it has more than five books, then a row of 150 px cover cards. Filters still apply inside groups.
- **Group by None**: a plain grid, `repeat(auto-fill, minmax(150px, 1fr))`, 28 px row gap, 20 px column gap.
- **List view**: rows with 40 px cover, title, author, length, progress, ⋮.
- Card states: progress bar (in progress); round accent check (finished); a status line under the author for "Needs OCR" (warning color, `TriangleAlert`) and "Processing…" (secondary, spinning `RefreshCw`).

### Book page (`/books/:id`) — `reference/desktop-book.html`, `desktop-book-menu.html`, `desktop-book-manage.html`, `phone-book.html`

Main pane uses the cover glow. Two columns, wrapping to one on narrow screens:

**Left column** (up to 340 px):
1. Cover, up to 300 px wide, 2:3, 12 px radius, cover shadow, accent progress bar along its bottom when in progress.
2. Title (Sora 36 px), author (17 px, 600, a link to `/search?q=<author>` filtered to Books), meta "Book · English · 4 h 12 m · 12 chapters" (14 px, secondary).
3. Description: three lines, then a "More" link that expands it inline (sanitized text only).
4. Progress: 4 px pill track with accent fill, then "38% · 2 h 36 m left". Hidden when not started.
5. Actions row: the primary white pill (48 px) and a 44 px outlined ⋮ button. **Nothing else.**
   - Primary pill label: not started → "Play"; in progress → "Resume Chapter N"; this book is playing → "Pause"; finished → "Play again".
6. **⋮ book menu** (raised fill, 12 px radius, drops below the button):
   - **Mark as finished** (`CircleCheck`; becomes "Mark as unfinished" when finished; shows a toast "Marked as finished · Undo")
   - **Reset progress** (`RotateCcw`; confirm dialog "Reset your progress in {title}?")
   - **Narrator voice…** (`Speech`): opens a dialog listing the voices for the book's language with a Preview (play) button each, plus "Use my default for {language}". This is the **only** place a book's narrator is chosen.
   - **Go to author** (`User`)

**Right column**:
- Pill **tabs**: Chapters, About, **Manage** (Manage only for the uploader and admins). Selected tab: white pill with dark text.
- **Chapters**: rows 52 px, 12 px radius:
  - number (secondary, tabular, 32 px column), title (15 px, 500), length on the right;
  - **played**: whole row in secondary color plus a `Check` and an sr-only "Played";
  - **playing**: raised fill, an accent `AudioLines` icon instead of the number, title 700, a second line "64% · 4:28 left", sr-only "Playing,";
  - clicking a row plays that chapter.
- **About** (not drawn in D; build from this spec): full description, then a details list (label column 140 px, secondary labels): Author, Series, **Genre**, Publisher, Published, Language, Length, Narrator (shows the book's narrator voice; read-only here), ISBN, Source file, Added (date and who). Tags as raised pill chips that link to a tag search. Hide empty rows.
- **Manage** (uploader or admin): settings-style rows separated by dividers, each with a bold title, a one-line explanation and its controls on the right:
  1. **Details**: "Cover, title, author, description and other metadata." plus how many fields are protected from automatic updates; "Edit details" (`Pencil`, opens the Edit details drawer) and "Find metadata" (`Globe`) outlined pills. **There is no separate Cover row any more**: the cover is edited only in the Edit details drawer.
  2. **Chapters to narrate**: "12 of 14 on", one row per chapter with its length and a **switch**; first four shown, then "Show all 14". Off chapters are skipped by the player and TTS.
  3. **Pronunciation**: "Add rule" pill; each rule shows "written → spoken" as two raised fields with a remove (`X`) button.
  4. **Processing**: status and explanation; "Reprocess" pill.
  5. **Delete book**: danger-outlined pill with `Trash2`; confirm dialog that repeats the title.
- Phone: a single column. Back and ⋮ in the header; centered 180 px cover; title, author, meta with percent; a full-width "Resume Chapter N" pill; tabs; chapter rows.

### Edit details drawer — `reference/desktop-book-edit.html`

Replaces the current full-page "Edit metadata" view. Opened from Manage → Details → "Edit details". The route can stay `/books/:id/edit` (deep-linkable) but it renders the **book page with a drawer on top**, not a separate page; closing the drawer returns to `/books/:id` on the Manage tab.

- **Container**: a right-side drawer, 600 px wide (full screen on phone), `--color-surface`, 1 px left border, a large shadow, over a 62% black scrim that covers the whole app including the sidebar and the player bar. `role="dialog"`, `aria-modal="true"`, focus moves to the title field, focus is trapped, Esc or the scrim closes (with the unsaved-changes check). Slides in from the right (250 ms; instant with reduced motion).
- **Header** (fixed): "Edit details" (Sora 24 px) and the line "Fields you change here (marked with a lock) are protected from automatic updates."; a close (`X`) icon button on the right.
- **Body** (scrolls inside the drawer, no visible scrollbar) in groups, each with an eyebrow heading and a divider above it:
  1. **Cover**: the current cover (96 px wide, 2:3) beside "Upload image" (`Upload`) and "Paste link" (`Link`) outlined pills, the hint "JPG, PNG or WebP. You’ll crop it to 2:3 next.", and an underlined "Remove cover" text button. Choosing an image or a link opens the crop step inside the drawer (not drawn: the image with a fixed 2:3 frame you drag and zoom, then "Use cover" / "Back"). This is now the **only** place to change a cover.
  2. **Book**: Title; Subtitle (placeholder "Optional"); **Authors** as removable chips in one field (each chip has a drag handle (`GripVertical`) to reorder and an `X` to remove; type and press Enter or comma to add; hint "Drag to reorder. The first author is shown on covers and lists."); Series and Number side by side (Number 120 px).
  3. **Publication**: Publisher and Published side by side; **Published accepts a year or a full date** (show "2008" or "2008-01-01", never the raw timestamp "2008-01-01T05:00:00+00:00"); Language and **Genre** selects side by side (Genre uses the fixed genre list plus the current value).
  4. **Identifiers**: ISBN-10 and ISBN-13 side by side (validate checksums on blur; inline error under the field).
  5. **Tags**: removable chips in one field, same behaviour as Authors (order doesn't matter, so no drag handles needed; the frame shows them, either is fine).
  6. **Description**: a multi-line field (18 px radius), plain text. When filling it from metadata providers, strip HTML and replace characters the font can't show (the current build shows empty boxes).
  - Inputs are 44 px pills on `--color-raised`; labels 13 px, 600, above each field with a 24 px label row so side-by-side fields line up.
  - **Locked fields**: a field whose value was set by hand shows a small accent lock icon after its label (button: "Title is protected from automatic updates. Unlock"). Clicking it unlocks the field (icon disappears) so "Find metadata" may update it again.
- **Footer** (fixed): on the left a count of unsaved changes ("2 unsaved changes", polite live region; empty when nothing changed); on the right "Cancel" (outlined) and "Save" (white primary pill, disabled until something changes). Saving closes the drawer and shows the updated book page; every field changed in this save is added to `locked_fields`.
- **Removed from this form**: the "Narrator voice override" field. A book's narrator is chosen only from the book's ⋮ menu → "Narrator voice…".
- **Unsaved changes**: closing with changes asks "Discard changes?" (Discard / Keep editing).

### Now playing, expanded (`/player`) — `reference/desktop-player.html`, `phone-player.html`, `phone-read-along.html`

Opened from the player bar (middle block or `ChevronUp`). The sidebar stays; the main pane shows the player with the strong cover glow; the player bar stays at the bottom with `ChevronDown` ("Close player") replacing `ChevronUp`.

- **Left**: cover up to 360 px (14 px radius, shadow), then the chapter title (Sora 30 px) and "Chapter 3 · Book · Author" (secondary), centered.
- **Right** (up to 620 px): tabs **UP NEXT / READ ALONG / ABOUT** (uppercase, 14 px, 700, 0.08em; selected tab white with a 2 px white underline, others secondary).
  - **Read along**: a small row with "Follows the narration", a text-size button and an "Auto-scroll on" pill. The text: past sentences at 38% white, the current sentence full white and larger, upcoming sentences at 62% white. The text scrolls inside its own area (the window never scrolls) and keeps the current sentence about a third from the top while auto-scroll is on. If the user scrolls, auto-scroll pauses and a "Back to current" pill appears.
  - **Up next**: the remaining chapters of this book as chapter rows (same component as the book page).
  - **About**: the book's cover, title, author, short description and a link to the book page.
- **Phone player**: full screen, no bottom nav or mini player. Header: `ChevronDown` (close), "NOW PLAYING" eyebrow, ⋮. Cover 236 px, chapter title and "Book · Ch. 3", the scrubber (accent) with times, then previous, back 15, **72 px white play/pause**, forward 30, next; then a speed pill and sleep. Bottom tabs UP NEXT / READ ALONG / ABOUT open their panel as a sheet over the player.
- **Phone Read along** sheet: drag handle; a strip with `ChevronDown` (back to player), small cover, chapter and book, and text size; the three tabs with Read along selected; the text (21 / 25 px) with no visible scrollbar and faded top and bottom edges (`.no-scrollbar .fade-edges`); pinned controls at the bottom: scrubber, speed pill, back 15, 60 px play/pause, forward 30, auto-scroll toggle (accent when on). Optional setting later: keep the screen on while reading (Wake Lock API).

### Search (`/search?q=`) — `reference/desktop-search.html`

- The top bar field holds the query (accent border, clear button).
- Type chips: All, Books, Authors, Series.
- A polite status line: "4 results for “wells”".
- **Top result** (left, up to 460 px): a surface card with 20 px radius. For an author: a 96 px round avatar placeholder, the name (Sora 28 px), "Author · 3 books · 1 finished", a white "Play" pill (plays the author's most recent in-progress book, or the first book) and a "View books" outlined pill. For a book: its cover instead, "Book · Author · length", "Resume"/"Play" and "Open".
- **Books** (right): rows with a 40 px cover, title, "Book · Author · 3 h 32 m" (matched text bold in `--color-fg`), a finished `Check` or progress, and ⋮ (same menu as the book page).
- Empty: "No books match “{q}”" and an "Upload books" pill.

### Upload (`/upload`) — `reference/desktop-upload.html`

- Eyebrow "Add to your library", title "Upload".
- Drop zone: 2 px dashed `#4A4A52` border, 20 px radius, the bookmark mark (56 px), "Drop books here" (Sora 24 px), the limits line ("EPUB, PDF, MOBI, AZW or AZW3 · up to 200 MB each · no DRM or KFX"), and a white "Choose files" pill with `Upload`.
- **This session**: title plus a polite summary "2 in progress · 3 added · 1 failed"; one surface row (14 px radius) per file: status icon, file name and size, status text, an action on the right, and a progress bar (accent on the border track) while uploading or converting. States: Uploading · N% (determinate bar); Converting Kindle file to EPUB… (indeterminate bar); Ready · N chapters (success, "Open book"); Added · scanned PDF, needs OCR (warning, "Open book"); Already in your library ("Open book" goes to the existing book); Couldn't add · {reason} (danger, "Remove").

### Settings (`/settings`, from the account menu) — `reference/desktop-settings-playback.html`, `desktop-settings-voices.html`

Title "Settings", then two columns: on the left a vertical list of section buttons, **Playback** and **Voices** (44 px pills; selected = raised fill, primary text, 700; others transparent with secondary text). On the right **only the selected section's settings** are shown (max 760 px). Playback is selected by default. Implement as a vertical tab list (`role="tablist"`, `aria-orientation="vertical"`, `role="tab"` with `aria-selected`/`aria-controls`, `role="tabpanel"`, arrow keys move between tabs). Reflect the section in the URL (`/settings/playback`, `/settings/voices`) so it survives reload and can be linked. On phone the two buttons sit side by side above the content. Nothing else (no Appearance/Theme, no Account section).

- **Playback** rows (bold title, secondary one-line explanation, control on the right, divider between rows):
  - Default speed: pill select (0.75× to 2.5×).
  - Skip back / Skip forward: a **stepper** (− value +, 5 to 120 seconds, step 5) followed by "sec". The player's skip labels use these values.
  - Auto-play next chapter, Speak chapter titles: **switches** (44×26 pill; on = accent track with a dark knob; off = `--color-off` track with a white knob; `role="switch"`).
- **Voices**: one secondary line: "Your narrator for each language. You can still pick a different narrator for any book from its ⋮ menu." Then **one row per language: English, Japanese, Korean, Chinese.**
  - **Chinese is one language.** Do not split Simplified and Traditional (`zh`, `zh-CN`, `zh-TW`, `zh-Hans`, `zh-Hant` books all use the Chinese preference). Remove any `zh-TW` row or setting.
  - Only show languages that have at least one voice on the server.
  - Each row: the language name with its code in secondary text, a 250 px pill select (wide enough for "Server default (Ashley)" without truncation) and a 40 px outlined Preview button (plays the selected voice; `Pause` while playing).
  - The select lists **only that language's voices, by the display names the admin set** (Admin → Voices), never raw IDs unless a voice has no name. The first option is **"Server default ({name})"**, meaning "follow whatever the admin sets as this language's default", and is the initial value. Choosing a specific voice pins it.
  - A pinned voice that disappears from the server falls back to the server default; show "{name} (no longer available)" until the user changes it.
- **Precedence** when a book plays: the book's own narrator (chosen from the book's ⋮ menu, per book) → the user's preference for the book's language (this page) → the server default for that language (Admin → Voices).
- Every change saves immediately; on failure revert the control and show an inline error under its row.
- Data: user settings store `voices` as a map of language → voice ID or `null` (null = server default), keyed by base language (`en`, `ja`, `ko`, `zh`).

### Admin · Voices (`/admin`, "Voices" section) — `reference/desktop-admin-voices.html`

Replaces the current "Voice names" section. It uses **exactly the same styling as the user Settings page**: no card, no gray box, rows on the page background separated by dividers. The TTS server can have **several voices per language**, so the list is **grouped by language**.

- **Admin section list** (left, same as Settings): Jobs, Cache, Users, **Voices**; selected = raised-fill pill, 700 weight, no accent outline.
- **Section header** (Settings section component): "Voices" (Sora 24 px), "Refresh voices" outlined pill on the right, then three short secondary paragraphs: (1) "Friendly names for the voices on your TTS server, grouped by language. The default is used for books in that language unless a listener or a book picks another voice." (2) "Each voice’s language is detected automatically, from the language the TTS server reports or from the end of the voice ID: -en English, -ja Japanese, -ko or -kr Korean, -zh Chinese. Voices whose language can’t be detected go to Unassigned until you pick one; listeners don’t see them until then." (suffixes in monospace, primary color) (3) "{N} voices on the server, checked {time} ago."
- **Language groups**, in this order: languages that have books in the library (by number of books, largest first), then other languages alphabetically, then **Unassigned**, then **No longer on the server**.
  - Group heading: language name (Sora 18 px, 700) with its code in secondary text ("English en"); on the right, "3 voices". Unassigned says "Language couldn’t be detected · N voices".
  - Each group is a `role="radiogroup"` for its default.
- **Voice row** (Settings row component):
  - Title: voice ID in monospace, 15 px, 600.
  - Description: usage, "Used by 74 books" / "Not used yet".
  - Controls: 200 px pill input for the display name (placeholder "Display name"; empty shows the ID), a 40 px outlined round Preview (`Play`/`Pause`), and the **default control**:
    - the language's default: accent-filled pill "✓ Default" (`role="radio"`, `aria-checked="true"`);
    - other voices: outlined pill "Set default" (`aria-checked="false"`); choosing it moves the default in that group and saves immediately.
  - Exactly one default per language. A language's first voice becomes its default automatically when it appears. This is the server-wide default (previously `TTS_VOICE_MAP`); a listener's own choice in Settings and a book's own narrator still override it.
  - **Unassigned** group (heading "Unassigned", note "Language couldn’t be detected · N voices"): voices whose language can't be detected. These rows have **no display-name field and no default control**: only the ID, the description "Assign a language to name it and offer it to listeners", the Preview button and an **"Assign language…" pill select** (English, Japanese, Korean, Chinese). Unassigned voices are never offered to listeners.
  - **Assigning** saves immediately and **moves the row out of Unassigned into that language's group** (it does not stay in Unassigned). In its new group the row is a normal voice row (display name field, Preview, Set default) and its description is followed by a small outlined **"Unassign"** pill (`RotateCcw`, label "Unassign {id}"). Only voices whose language was set manually get this pill; there is no extra "set by you" text. If the group had no voices, the voice becomes its default.
  - **Undo** is the "Unassign" pill only (no toast or popup). It returns the voice to Unassigned, clears its language override and keeps any display name it was given (shown again when it is re-assigned). If it was that language's default, the next voice in the group becomes the default. Voices whose language was detected automatically have no "Unassign" control.
  - Store the manual choice as `language_override` on the voice (null = use detection). Detection otherwise uses the same suffix rules as before (`-en`, `-ja`, `-kr`/`-ko`, `-zh`, or a `language` field from the server); all Chinese variants map to one **Chinese** group.
  - **No longer on the server** group: rows show a warning description ("Not on the TTS server · 1 book falls back to its language default") and a "Remove" pill instead of Preview and Default. If the removed voice was a language default, the next voice in that language becomes the default.
- **Saving**: names save on blur or Enter; defaults save on click; errors appear under the row. No Save button.
- **Where names and grouping are used elsewhere**:
  - Settings → Voices: each language's dropdown lists **only that language's voices** by display name, with "Server default ({name})" first.
  - The book's Narrator voice dialog lists the book language's voices first, then "Other languages" collapsed.
  - Everywhere a voice is shown to a listener: "Name · Language"; the raw ID only when no name is set.
- Data: keep the alias storage; add a per-language default table or setting; `GET /voices` returns `{id, display_name, language, is_default, books_count, on_server}`.

### Sign in (`/login`) — `reference/desktop-login.html`

No sidebar or player. The accent glow background. A centered 380 px column: the bookmark mark (64 px) and "folio" (Sora 34 px), then Username and Password (48 px pill inputs, raised fill, labels above; password has an `Eye`/`EyeOff` toggle), then a 52 px white "Sign in" pill. Errors: an alert above the fields (danger), both fields `aria-invalid`, focus to Username, password cleared, never say which field was wrong. "Signing in…" while the request runs. Same layout on phone.

### Dropdowns everywhere

Native selects with `appearance: none`, 40 px pill, raised fill, 18 px left padding, 44 px right padding, and a `ChevronDown` icon (18 px, secondary) absolutely positioned 16 px from the right with `pointer-events: none`. The opened list stays the browser's native one.

---

## 5. Data and API changes

1. **Genre** (new):
   - Add `genre TEXT NULL` to `books` (Alembic migration).
   - On metadata fetch, map the first recognizable Open Library / Google Books subject to a genre from a short fixed list kept in config: Classics, Literary fiction, Science fiction, Fantasy, Mystery & thriller, Gothic & horror, Romance, Historical fiction, Myth & epic, Poetry, Drama, Biography & memoir, History, Science, Philosophy, Nonfiction, Children's, Japanese literature, Korean literature, Chinese literature. Unmapped → NULL.
   - Never overwrite a genre the user set (add `genre` to `locked_fields` on manual edit).
   - Editable in Edit details (select from the list or type a new one). Shown on the About tab.
   - `GET /books` accepts `group=genre|author|language|status|none` and `genre=`; when grouped, return `{groups: [{key, label, count, books: [...]}]}` with the first N books per group (N = 12) and "No genre yet" last.
2. **Cover color**: add `cover_rgb TEXT NULL` ("35 70 107"), computed when a cover is stored or changed. Return it with the book. The book page and player set `--cover-rgb` from it.
3. **Home data**: add `GET /me/home` returning `continue` (in-progress books, most recently played first, with chapter and time left), `next_chapters` (for each in-progress book, its next unplayed chapter with length), and `recent` (newest books). Respect the same filters as the chips (`status`, `language`, `max_minutes`).
4. **Search**: `GET /search?q=&type=all|books|authors|series` returning `top` (one author or book) plus `books`, `authors`, `series` lists.
5. **User settings**: remove `theme`. Keep speed, skip back/forward, auto-play, speak chapter titles. Per-language voices become a map of base language (`en`, `ja`, `ko`, `zh`) → voice ID or `null` for the server default; migrate any `zh-TW` value into `zh` (keep `zh` if both exist).
6. **Routes**: `/` Home (new), `/library` Library (moved), `/search` Search (new page), `/player` expanded player (new layout), others unchanged. Keep `?q=` working on `/library` by redirecting to `/search?q=`.

---

## 6. Accessibility (unchanged requirements, new specifics)

- Text contrast 4.5:1 and controls 3:1 (the tokens pass). Accent is not used for text.
- Every icon-only button has an `aria-label` that includes its current value ("Playback speed, 1.25 times", "Back 15 seconds").
- Menus: `aria-haspopup="menu"`, `aria-expanded`, `role="menu"`/`menuitem`, arrow keys, Esc returns focus.
- Tabs: `role="tablist"`/`tab`/`tabpanel`, arrow keys.
- Filter chips and view toggles: `aria-pressed` or `role="radio"` inside a group.
- Switches: `role="switch"` with `aria-checked`.
- Played / playing chapter states include sr-only text.
- Live regions: search result count, upload summary, toasts (`aria-live="polite"`).
- The read-along current sentence has `aria-current="true"`; do not announce every sentence change.
- Focus ring: 2 px accent outline with 2 px offset everywhere.
- Reduced motion handled globally in `tokens.css`.

---

## 7. Implementation plan (stop after each phase)

1. **Foundations.** Replace `tokens.css`; install Sora and Figtree, remove the old fonts; delete theme code and the theme setting; add `lucide-react` and remove the Material Symbols package; copy `brand/web/` into `frontend/public/`, paste `head-snippet.html` into `index.html`, put `brand/svg/folio-mark.svg` in `frontend/src/assets/`. *Check:* app builds dark, no CDN requests, no theme UI anywhere.
2. **Shell.** Sidebar (with collapse), top bar with search and the account menu, phone header and bottom nav, tablet rail; routes `/`, `/library`, `/search`. Remove the icon rail. *Check:* every page reachable on desktop, tablet and phone; Admin only for admins.
3. **Player.** Player bar, phone mini player, expanded `/player` page with the three tabs, phone player and Read along sheet; remove the side panel, collapse bar and focus mode; enforce the visibility rules. *Check:* one audio element; Media Session works; reading never scrolls the window.
4. **Book page.** Two-column layout, primary pill states, ⋮ menu (including the Narrator voice dialog), Chapters / About / Manage tabs, cover glow. Remove every other narrator voice button. *Check:* app open → audio in two clicks; Manage hidden for other users.
5. **Home and Library.** `/me/home`, shelves, chips; Library Group by with the Genre data change and migration; grid and list views. *Check:* 5,000-book library loads groups quickly (paged groups).
6. **Search, Upload, Settings, Sign in.** As specified; Settings has only Playback and Voices. *Check:* keyboard only, 390 px and 1440 px.
7. **Restyle the rest and clean up.** Apply tokens and components to the undesigned screens; remove dead code, old icons, old fonts and old assets; rewrite `DESIGN.md` for Direction D; update `docs/DECISIONS.md`.

---

## 8. Not designed (restyle only, keep their structure)

Find metadata (results picker), the cover crop step inside the Edit details drawer, the Narrator voice dialog, confirm dialogs, Admin Jobs, Cache and Users sections, the About tab (spec above, no frame), the empty, loading, error, offline, needs-OCR and failed states. Use: raised surfaces, pill controls, white primary pills, Sora titles, Figtree text, the accent only for selection and progress.

## 9. Decisions log (for `docs/DECISIONS.md`)

- Direction D replaces Direction C entirely; the YouTube Music structure is the model (sidebar, top search, chips, shelves, bottom player bar, expanded player with tabs), not its branding.
- Dark only; no light mode, no theme setting.
- Accent is Amber `#FFC233` (Tangerine, Pink, Sky and Lilac were considered; red and green rejected: red is YouTube's, green didn't feel right). The accent is one variable so it can still be changed.
- Fonts: Sora (display) and Figtree (UI). Read-along uses Figtree in a lyrics style instead of a serif page.
- Logo: the bookmark ribbon with a play triangle cut out, lowercase "folio" in Sora.
- Narrator voice per book lives only in the book's ⋮ menu; per-language defaults stay in Settings.
- The library groups by Genre by default; Genre is a new book field.
- The Now Playing side panel, collapse bar and focus mode are replaced by the bottom player bar and the expanded player page.
- Cover percentage badges are replaced by a progress bar on the cover and a check for finished books.
- Scrollbars are hidden on phone scroll areas; the read-along fades at its edges.
- Dropdowns draw their own chevron inset 16 px from the edge.
- Back skip 15 s, forward 30 s, both configurable 5–120 s in Settings.
