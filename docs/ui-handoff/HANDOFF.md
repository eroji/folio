# Folio UI redesign — implementation handoff (Direction C "Companion")

You are implementing an approved UI redesign of Folio, an existing React 19 + Vite + TypeScript + Tailwind 4 app. The backend, API, routes and data model do not change. This document is the source of truth; the HTML files in `reference/` show the target look for the two screens that were fully designed.

## How to work

1. Read this file end to end, then open the files in `reference/` in a browser. Each file names its screen in a comment at the top; change `data-theme` on the root element to preview the other theme.
2. Work one phase at a time (see "Implementation plan"). Finish a phase, run `npm run lint`, `npx tsc --noEmit` and the existing tests, then stop and report before starting the next.
3. Do not invent new layouts for screens that were not designed (see "Not designed yet"). Restyle them with the new tokens and components only.
4. Keep the functional contract in `UI-REDESIGN-BRIEF.md` §7 intact. Anything you must change in it, list in `docs/DECISIONS.md` with a one-line reason.
5. Record every deviation from this document in `docs/DECISIONS.md`.

## Files in this package

| File | Use |
| --- | --- |
| `frontend/src/styles/tokens.css` | Drop-in replacement for the existing tokens file: colors (light and dark), type, radii, CJK font stacks, focus, reduced motion, touch density |
| `reference/desktop-book-light.html`, `desktop-book-dark.html` | Desktop book page (Chapters tab) with the Now Playing panel |
| `reference/phone-book-light.html`, `phone-book-dark.html` | Phone book page with the Now Playing sheet and tab bar |
| `reference/desktop-book-about.html`, `desktop-book-manage.html` | About and Manage tabs |
| `reference/desktop-library.html` | Library |
| `reference/desktop-search.html` | Search (rail Search icon) |
| `reference/desktop-upload.html` | Upload (rail Upload icon) |
| `reference/desktop-account-menu.html` | Account menu open |
| `reference/desktop-player-closed.html`, `desktop-player-collapsed.html`, `desktop-player-other-device.html` | Player visibility states |
| `reference/desktop-focus-mode.html` | Focus mode (full-screen player) |
| `reference/desktop-login.html`, `phone-login.html` | Sign in (the error alert is in the DOM, hidden) |

The reference files are static exports, not production code: use their layout and proportions, but take every value from `tokens.css`. Menus exist in their DOM with `hidden`; remove the attribute to inspect them.

## Final decisions

### Layout

- **Desktop shell:** a 60 px icon rail on the left, the page in the middle, and a persistent **Now Playing panel** on the right whenever a book is loaded. Page and panel split the remaining width **50/50**. Below 1,050 px viewport width they stack (page first).
- **When the player shows (one rule, every page):** the panel (desktop) and sheet (phone) are present whenever a book is **loaded**, playing or paused. They never appear or disappear on play/pause.
  - On app start, load the user's most recently played book, paused at its saved position, so Resume is one click from any page. A user with no listening history has nothing loaded.
  - **Close** (`close` icon, "Stop and close player") stops playback, saves progress and unloads the book: the panel/sheet is removed and the page takes the full width until the user plays something.
  - **Collapse** (`keyboard_double_arrow_right`, "Collapse player to a bar") turns the panel into a 64 px bar along the bottom of the content area: cover, chapter and book title, back, play/pause (40 px), forward, scrubber with time and speed, Expand (`keyboard_double_arrow_left`) and Close. Collapsed/expanded is a remembered user preference (localStorage), never switched automatically per page.
  - **Other devices:** if the loaded book was last played on another device, show it paused at the synced position with a status line "Paused · last played on {device} {time ago}". Never start a second player automatically.
  - Header buttons, left to right: Collapse, Focus mode, Close. Each has a tooltip with its shortcut: Collapse/Expand player (P), Focus mode (F), Esc exits focus mode.
  - **Collapsed bar:** clicking the cover or titles also expands the panel (the whole area is one button, "Expand player: {chapter}, {book}"). Collapse animates the panel sliding right and down into the bar (200 ms); expand reverses it; reduced motion switches instantly.
- **Focus mode (full-screen player)**, opened from the panel's `open_in_full` button or F:
  - Replaces the whole window: no rail, no page, no panel. Background is the paper color.
  - Slim header: small cover, book title and author on the left; A− / A+ text size, Contents toggle (`toc`, C), divider, "Exit focus" (`close_fullscreen`, Esc) on the right.
  - Optional contents list on the left (current chapter selected with chapter percent, finished chapters with a check); the reading page centered at max 680 px, Newsreader 21 px / 1.75, chapter label and title above the text, internal scroll, current sentence highlighted and kept in view.
  - Transport card centered at the bottom (max 860 px): scrubber row with time and speed, then speed · previous · back · play/pause (48 px) · forward · next · sleep · voice. Space toggles play/pause.
  - Exiting returns to the exact page and panel state the user came from.
  - On phones there is no separate focus mode: the full-screen phone player plays this role.
- **Icon rail (top to bottom):** logo, Library, Search, Upload; the **account avatar is pinned to the bottom**. There is no Settings or Admin item in the rail.
- **Account menu** (opens from the avatar, to the right of the rail, sized to its content): avatar, display name, username and role; **Settings**; **Admin** (rendered only for admins); **Theme** as an inline three-way switch **System / Light / Dark** (`role="menuitemradio"`, one click, no submenu); divider; **Sign out**. Rows 32 px, 18 px icons. The theme toggle is removed from any top bar.
- **Phone shell:** 48 px header (back, ⋯), scrolling content, the **Now Playing sheet** pinned above the tab bar when a book is loaded, then a 56 px **tab bar: Library, Search, Upload, You**. "You" shows the avatar and opens the same items as the account menu (as a page or sheet).
- **Search** is not a new route: it navigates to `/` with the library search field focused (keep the existing `q` query handling).

### Book page (`/books/:id`)

Hierarchy: what the book is → play it → manage it.

1. **Hero:** cover (desktop 120×180, phone 64×96) with the **progress badge**, title, author, meta line (language, length, chapter count, narrator on desktop), overall progress bar with "38% · 2 h 36 m left", then the primary action.
2. **Primary action** (the only gradient button on the page):
   - not started → **Play**
   - started, not the loaded book, or loaded and paused → **Resume**
   - this book is loaded and playing → a non-gradient **Playing now** state (selected background, accent text, headphones icon); pressing it focuses the Now Playing panel (desktop) or expands the sheet (phone).
   - Phone shows the narrator **voice icon button** (no border, no fill) beside it.
3. **⋯ book menu** (listener actions, everyone sees it): **Mark as finished** (becomes **Mark as unfinished** when finished) and **Reset progress**. Marking finished shows a toast "Marked as finished · Undo". There is **no download item**: audio is never cached offline.
   - Desktop: a 36 px bordered icon button next to the primary action. Phone: the ⋯ in the header.
   - The menu sizes to its content (`width: max-content`), rows 30 px (desktop) / 34 px (phone), 18 px icons.
4. **Tabs: Chapters / About / Manage.**
   - **Manage** is rendered only for the book's uploader and admins. It holds Edit details, Find metadata, Book settings (chapter inclusion, pronunciation rules), Reprocess, Delete. Destructive actions confirm in a dialog.
   - **About**: description (sanitized), publisher, published date, ISBN, tags, language.
5. **Chapter rows** (tapping/clicking a row plays that chapter; no per-row play button):

| State | Number | Title | Right side |
| --- | --- | --- | --- |
| Played | secondary text | secondary text | check icon (`check`) + sr-only "Played" |
| Playing | accent (`--on-selected`) | semibold | desktop: percent of chapter, accent; phone: "Playing", accent |
| Not played | secondary | primary text | chapter length ("18:05" desktop, "18 m" phone) |

The playing row on desktop has a surface background and divider border.

### Cover progress badge

Bottom-left on any cover that represents a book (book page hero, library grid, continue listening): dark tag `rgba(18,20,31,0.82)` with white text, inset 6 px (desktop) / 4 px (phone). Not started: no badge. In progress: overall percent ("38%"). Finished: `check` icon. The badge is `aria-hidden`; the cover's accessible name carries the state ("The Lighthouse at Low Tide, 38% listened" / "…, finished") wherever the progress text is not already shown beside it.

### Now Playing panel (desktop)

Top to bottom: "Now playing" heading + **focus mode** button (`open_in_full`), cover 36×54 with chapter title and "Chapter 3 · Book title", scrubber row, transport row, read-along.

- **Scrubber row:** elapsed · range input · remaining **plus current speed** ("−4:28 · 1.25×"), tabular numbers.
- **Transport row, one line, in this order:** speed, previous chapter, back 15 s, **play/pause (44 px round gradient)**, forward 30 s, next chapter, sleep timer, narrator voice. Speed, sleep and voice are secondary color; the five transport controls are primary color. Each icon button carries its value in its accessible name ("Playback speed, 1.25 times", "Sleep timer, off", "Narrator voice, ashley-en"). Sleep shows a small countdown badge while a timer runs.
- **Read-along:** its own paper surface, internal scroll only (the window never scrolls), Newsreader 17 px / 1.65, current sentence on `--highlight`, already-read text in secondary color, `lang` set from the book.
- **Focus mode** expands the read-along to the full content width (layout not designed; see below).

### Now Playing sheet (phone)

Pinned above the tab bar: drag handle, 30×45 cover, chapter title, "8:12 / 12:40 · 1.25×", back button, 44 px round gradient play/pause, then a 3 px progress line. Swiping up or tapping expands to the full phone player (not designed; see below). Only one audio element may exist app-wide; panel, sheet and full player all drive the same player state.

### Other designed screens (desktop)

All use the app shell above, with the Now Playing panel when a book is loaded.

**About tab.** Description in the reading font (16 px / 1.6, max 640 px), then a two-column details list (140 px label column): Author (link to a search for that author), Series, Publisher, Published, Language, Length ("About 4 h 12 m · 12 chapters"), Narrator, ISBN, Source file ("EPUB 3 · 1.2 MB"), Added (date and who). Tags as small chips (link to a search for the tag). Hide rows whose value is empty.

**Manage tab** (uploader or admin). Stacked cards (8 px radius, 16 px padding), max 680 px wide:
1. **Details:** note "N fields you edited by hand are protected from automatic updates"; buttons Edit details, Find metadata.
2. **Chapters to narrate:** checkbox per chapter with its length; "12 of 14 included" count; first five shown, then "Show all 14". Unchecked chapters are skipped by the player and TTS.
3. **Pronunciation:** table Written | Say it as | remove button, plus Add rule. Rules apply only to this book.
4. **Processing:** status line with icon ("Ready · 14 chapters from EPUB 3 · processed {date}"), explanation that reprocessing rebuilds chapters and clears this book's generated audio but keeps progress; Reprocess book button.
5. **Delete book:** card with a danger-colored border, text saying what is removed and that it can't be undone, danger outline button. Confirm in a dialog that repeats the book title.

**Library** (`/`). Title "Library" with the search field beside it. **Continue listening:** up to 3–4 resume cards (cover with badge, title, "Ch. 3 · 2 h 36 m left"); clicking resumes playback. **All books:** filter chips All / In progress / Not started / Finished with counts (`aria-pressed`), Sort select (Recently added, Title, Author, Progress), and a cover grid (`repeat(auto-fill, minmax(128px, 1fr))`). Each card: cover with progress badge, title (2 lines max), author, and a status line only when not ready ("Needs OCR" in warning color, "Processing…" with a spinner, "Couldn't process" in danger color). Finished is a filter, not a separate shelf.

**Search** (rail Search icon, or "/" anywhere; route stays `/` with `?q=`). The field is focused and highlighted. A status line announces the count ("4 results for “wells” in titles, authors and series", `role="status"`). Results grouped under **Authors** (row with person icon and book count; opens a filtered library) and **Books** (small cover, title, author, progress or "Not started · length"). Matched text uses `<mark>` on the highlight color. Esc clears. Empty result: "No books match “{q}”" with a link to Upload.

**Upload** (`/upload`). Title, then a dashed drop zone (whole zone is a drop target) with "Drop EPUB, PDF or Kindle files here", a gradient **Choose files** button, and the limits line (200 MB, accepted extensions, no DRM or KFX). **This session** lists every file with an icon, name, size and live status from SSE: Uploading with percent and a progress bar; Converting Kindle file (indeterminate bar); Ready · N chapters (success, "Open book"); Added · needs OCR (warning, "Open book"); Already in your library (duplicate, "Open book" links to the existing book); Couldn't add with the reason (danger, Remove). A summary line ("2 in progress · 3 added · 1 failed") is a polite live region.

**Sign in** (`/login`). No rail or player. Desktop: a single 440 px card (8 px radius, 40 px padding) centered on the page background. Phone: the same content directly on the surface color, starting about 96 px from the top. Content: logo mark (real asset from `frontend/public/`) and "Folio" in the display font at 28 px; no subtitle. Username (`autocomplete="username"`) and Password (`autocomplete="current-password"`) with labels above, a show/hide password toggle (`visibility` / `visibility_off`, `aria-pressed`); a full-width gradient **Sign in** button, and nothing below it. On failure: an alert above the fields (`role="alert"`, danger border and text, `error` icon) reading "Incorrect username or password. Check them and try again.", both fields get `aria-invalid="true"` and a danger border, focus moves to the username field, and the password is cleared. Never reveal which of the two was wrong. Show "Signing in…" on the button while the request runs. The dev-only test-mode panel stays below the card, unchanged.

### Foundations

- **Fonts:** Plus Jakarta Sans (UI and display, 400–700) and Newsreader (reading), self-hosted with Fontsource variable packages. Titles 700 with `letter-spacing: -0.01em`. CJK falls back to system fonts, then Noto (stacks are in `tokens.css`); set `lang` on book-derived text.
- **Type scale (px):** 11 tab labels/badges, 12 meta/timestamps, 13 secondary, 14 body/rows/buttons, 15 panel title, 18 phone book title, 26 desktop book title, 17 read-along (user adjustable).
- **Colors:** only the semantic tokens in `tokens.css`. The gradient is used for the primary action, play/pause and the logo only. Brand blue `#2381F7` is never used for text.
- **Radii:** xs 1 px (progress, handle), sm 3 px (small covers, badge), cover 4 px, md 6 px (buttons, rows, inputs, icon-button hover), lg 8 px (cards, panels, menus, sheet top). Fully round only for the avatar and play/pause. Phone uses the same values as desktop.
- **Density:** desktop controls 36 px, rows 36 px, nav items 40 px; phone controls 44 px. Add the `.tap` class (or equivalent) to every interactive element so coarse pointers get 44 px.
- **Icons:** Material Symbols **Rounded, weight 400, outlined**; filled variant for play, pause, skip previous/next. Use `@material-symbols/svg-400` SVG imports (e.g. via `vite-plugin-svgr`), not the web font. Sizes 18 / 20 / 22 / 24. Remove `lucide-react` once nothing imports it.

| Use | Symbol |
| --- | --- |
| Library | `auto_stories` |
| Search | `search` |
| Upload | `upload` |
| Settings | `settings` |
| Admin | `admin_panel_settings` |
| Theme | `contrast` |
| Sign out | `logout` |
| Back | `chevron_left` |
| More | `more_horiz` |
| Play / Pause | `play_arrow` / `pause` (filled) |
| Previous / next chapter | `skip_previous` / `skip_next` (filled) |
| Back / forward | `replay`, and `replay` mirrored (`scaleX(-1)`), each with the interval number drawn inside in 8–9 px bold UI font ("15", "30"). The number follows the user's skip-interval setting, so any value works. |
| Speed | `speed` |
| Sleep timer | `bedtime` |
| Narrator voice | `record_voice_over` |
| Focus mode / exit focus | `open_in_full` / `close_fullscreen` |
| Contents toggle | `toc` |
| Show / hide password | `visibility` / `visibility_off` |
| Error | `error` |
| Collapse player / expand player | `keyboard_double_arrow_right` / `keyboard_double_arrow_left` |
| Close player | `close` |
| Other device | `devices` |
| Playing now | `headphones` |
| Played / finished | `check` |
| Mark as finished | `task_alt` |
| Reset progress | `restart_alt` |

### Accessibility (hard requirements)

- Text 4.5:1, controls and progress 3:1 in both themes (the token values already pass).
- Visible `:focus-visible` ring on every interactive element.
- Menus: `aria-haspopup="menu"`, `aria-expanded`, `role="menu"`/`menuitem`, arrow-key navigation, Escape closes and returns focus.
- Tabs: `role="tablist"`/`tab`/`tabpanel`, arrow keys switch tabs.
- Icon-only buttons have `aria-label` including the current value.
- Toasts in an `aria-live="polite"` region.
- Reduced motion respected (handled globally in `tokens.css`).
- Works at 200% zoom and with keyboard only.

## Open decisions (ask Jimmy before building these parts)

Settled: back skip stays **15 seconds** (forward 30), drawn with the numbered `replay` icons described under Icons.

1. **Resizable split.** A drag handle between the page and the Now Playing panel that remembers its position (default 50/50). Proposed, not confirmed; build the fixed 50/50 split first.
2. **Desktop target size.** The brief says 44 px everywhere; this design uses 36 px with a mouse and 44 px on touch (via `pointer: coarse`). Update the brief if accepted.

## Not designed yet

These screens keep their current layout and are only restyled with the new tokens, type, icons and components: Edit metadata, Find metadata, Settings, Admin, the full-screen phone player, the phone versions of Library, Search, Upload and the You page, and all empty, loading, error, offline, needs-OCR and failed-job states. Do not redesign them; flag anything that looks wrong in `docs/DECISIONS.md`.

## Implementation plan

Do these one at a time and stop after each.

1. **Foundations.** Replace `tokens.css`, add Fontsource packages, set `data-theme` on `<html>` from the user setting (System follows `prefers-color-scheme` live). Add the icon SVG pipeline and an `<Icon name size fill>` component. *Check:* app builds, both themes switch, no CDN requests.
2. **App shell.** Desktop icon rail with account menu; phone header, tab bar with avatar. Remove Settings/Admin from the old nav and the theme toggle from the top bar. *Check:* Admin appears only for admins; all routes still reachable.
3. **Player surfaces.** Now Playing panel (desktop) and sheet (phone) bound to the existing single audio player state; transport row, scrubber with speed, read-along with internal scroll and highlight. *Check:* only one audio element; Media Session still works; the window never scrolls while reading.
4. **Book page.** Hero, cover badge, primary action states, ⋯ menu with undo toast, tabs with Manage permission, chapter rows. *Check:* app open → audio in two taps; Manage hidden for non-uploaders.
5. **Restyle the rest.** Apply tokens, components and the cover badge to the undesigned screens without changing their structure. *Check:* both themes, 390 px and 1440 px, keyboard only.
6. **Clean up.** Remove `lucide-react` and unused styles; update `DESIGN.md` (icons, fonts, radii, density) and `docs/DECISIONS.md`.
