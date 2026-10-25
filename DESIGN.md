# DESIGN.md — Folio

> Direction C "Companion", as implemented. The tokens in `frontend/src/styles/tokens.css` are the single source of truth; this file explains how to use them. `docs/ui-handoff/HANDOFF.md` and `docs/ui-handoff/reference/*.html` show the target screens.

## Mode

- **App surfaces** (library, book, upload, settings, admin): *Operate*. Familiar patterns, scannability, one primary action per screen.
- **Read-along**: *Read*. A paper page with its own scroll; the text is the content.
- **Nothing here is Persuade.** The gradient appears on exactly three things: the primary action, play/pause, and the logo.

## Layout

- **Desktop shell (≥1050 px, `desktop:` breakpoint):** 60 px icon rail on the left (logo, Library, Search, Upload; account avatar pinned bottom — no Settings/Admin in the rail), the page in the middle, and a persistent **Now Playing panel** on the right whenever a book is loaded. Page and panel split the remaining width **50/50**; below 1050 px they stack.
  - **Collapse** turns the panel into a 64 px bar along the bottom of the content area (remembered in localStorage, never switched automatically). **Close** unloads the book and returns the page to full width.
  - **Focus mode** (`open_in_full`, F) replaces the whole window: paper background, slim header, optional contents list, reading page centered at max 680 px, transport card centered at the bottom (max 860 px). Esc returns to the exact page and panel state.
  - The **account menu** (from the avatar) holds Settings, Admin (admins only), an inline System/Light/Dark theme switch (`menuitemradio`), and Sign out. There is no theme toggle in any top bar.
- **Phone shell (<1050 px):** 48 px header (back, ⋯), scrolling content, the **Now Playing sheet** pinned above a 56 px tab bar (Library, Search, Upload, You). The full-screen phone player is the phone's focus mode.
- **Player surfaces** exist whenever a book is **loaded**, playing or paused — never on play/pause. One audio element app-wide; panel, sheet and full player drive the same state.
- **Search** is not a route: the rail icon navigates to `/` with the library search field focused (`?q=`).

## Identity

| Token | Use |
|---|---|
| `--bg` / `--surface` / `--raised` | page / cards and inputs / hover, menus, skeletons |
| `--divider` | lines only, never a control's only edge; `--control-border` (3:1) when a control needs one |
| `--fg` / `--fg-2` | primary / secondary text (both ≥4.5:1 in each theme) |
| `--accent-text` | links, active tab label, playing-row text. Brand blue `#2381F7` is **never** used for text |
| `--selected` / `--on-selected` | selected rows and chips |
| `--progress` / `--track` | progress fills / troughs and the focus ring |
| `--paper` / `--paper-border` / `--reading-fg` / `--highlight` | read-along page, its border, its text, the current sentence |
| `--avatar-bg` / `--avatar-fg` | rail/tab-bar avatar |
| `--cover-badge` | the dark cover progress tag (theme-independent) |
| `--success` / `--warning` / `--danger` | status only |
| `--color-brand-blue-strong` → `--color-brand-violet-strong` | the one gradient (`.bg-primary-gradient`) |

Type: **Plus Jakarta Sans** (UI and display, 400–700, self-hosted via Fontsource) and **Newsreader** (reading). Titles 700 with `letter-spacing: -0.01em`. CJK falls back to system fonts, then Noto; set `lang` on book-derived text.

- Type scale (px): 11 tab labels/badges · 12 meta/timestamps · 13 secondary · 14 body/rows/buttons · 15 panel titles · 18 phone book title · 26 desktop book title · 17 read-along (user adjustable). `font-ui` / `font-display` / `font-reading`; `.tabular` for times.

## Scale and rhythm

- **Radii:** xs 1 px (progress, sheet handle) · sm 3 px (small covers, cover badge) · cover 4 px · md 6 px (buttons, rows, inputs, icon-button hover) · lg 8 px (cards, panels, menus, sheet top). Fully round (999) **only** for the avatar and play/pause.
- **Density:** desktop controls and rows 36 px (`h-9`), nav items 40 px; every interactive element carries `.tap` so coarse pointers get 44 px. Phones author at 44 px.
- **Icons:** Material Symbols Rounded (weight 400, outlined; filled for play, pause, skip previous/next), imported as SVGs from `@material-symbols/svg-400` through `<Icon name size fill>` — not the web font. Sizes 18/20/22/24. Skip buttons draw the interval number inside a mirrored `replay` glyph.
- **Cover progress badge:** bottom-left dark tag (`--cover-badge`, white text) on any book cover — inset 6 px desktop / 4 px phone; percent when in progress, `check` when finished, nothing when not started. `aria-hidden`; the cover's accessible name carries the state.

## Components

- **Primary button:** `.bg-primary-gradient`, `text-on-primary`, `rounded-md`, one per screen (Play/Resume, Choose files, Sign in). The "Playing now" state is non-gradient: `bg-selected text-on-selected` with a headphones icon.
- **Secondary button:** `bg-surface` with a 1 px `border-control-border`, `rounded-md`.
- **Book card / row:** cover with progress badge, title 2 lines max, author 1 line; status text only when not ready (warning/danger color or spinner).
- **Book page:** hero (cover, title, author, meta line, overall progress bar) → primary action (+ voice icon button on phone) → ⋯ listener menu (Mark as finished with undo toast, Reset progress; no download) → tabs **Chapters / About / Manage** (Manage only for uploader/admin). Chapter rows carry no per-row play button: played = `check` + sr-only "Played", playing = accent text with percent (desktop) or "Playing" (phone), otherwise the length.
- **Now Playing panel:** "Now playing" + focus-mode button, 36×54 cover with chapter and book, scrubber row (elapsed · range · remaining + speed, tabular), one-line transport row (speed · previous · back 15 · play/pause 44 px round gradient · forward 30 · next · sleep · voice), then the read-along.
- **Read-along:** its own paper page (`--paper`, internal scroll only, `.reader-scroll`, Newsreader 17 px / 1.65), current sentence on `--highlight`, read text in secondary color, `lang` from the book. The window never scrolls while reading.
- **Menus:** `role="menu"`/`menuitem`, arrow keys, Escape closes and returns focus, sized to content (`max-content`), rows 30/34 px with 18 px icons.
- **Voice picker:** language voices only, first available preselected, no "Default", never the engine's `tts` fallback.
- **Destructive actions:** danger-bordered card or menu item, confirm in a dialog that repeats the book title.

## Interaction

- Press states change color/opacity only, never bounds.
- Focus: 2 px `--progress` ring with 2 px offset on every control (`:focus-visible`, global).
- Motion: 200 ms panel collapse (slides right and down into the bar); `prefers-reduced-motion` switches instantly and is honored globally in `tokens.css`.
- Loading: skeletons for grids and panels, "Preparing audio…" for synthesis, never a spinner over an empty screen. Every list has an empty state.
- Errors: inline, human, with the next action. Sign-in failure shows one alert ("Incorrect username or password…") without revealing which field was wrong.
- Toasts live in an `aria-live="polite"` region; result counts announce via `role="status"`.

## Accessibility baseline

Keyboard reachable, visible focus, 44×44 touch targets via `.tap`, 4.5:1 text and 3:1 for controls/progress in both themes (token values already pass), icon-only buttons carry `aria-label` including the current value ("Playback speed, 1.25 times"), tabs use `tablist`/`tab`/`tabpanel` with arrow keys, works at 200% zoom, `data-theme` on `<html>` follows the user setting (System tracks `prefers-color-scheme` live).
