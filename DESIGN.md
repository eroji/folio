# DESIGN.md — Folio

> Direction D "Ribbon", as implemented. Dark only, one accent, YouTube-Music-shaped
> shell. The tokens in `frontend/src/styles/tokens.css` are the single source of
> truth; `docs/ui-handoff/HANDOFF.md` and `docs/ui-handoff/reference/*.html` are the
> design source. This file describes what the app actually renders.

## Mode

- **Dark only.** `color-scheme: dark` is set once in `tokens.css`. There is no light
  theme, no `data-theme` attribute and no theme setting anywhere.
- The accent (Amber `#FFC233`, one variable `--color-accent`) is used **only** for
  fills, icons and progress — never for body text. Anything on an accent fill uses
  `--color-on-fg`.
- **Primary actions are white pills** (`bg-fg text-on-fg`, 700 weight): Play/Resume,
  Choose files, Sign in, Apply, Save, the play/pause button.

## Foundations

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#0B0B0C` | app + sidebar background |
| `--color-surface` | `#151517` | player bar, cards, upload rows, dialogs |
| `--color-raised` | `#202023` | chips, inputs, selects, selected nav item, menus, playing row |
| `--color-border` | `#2E2E33` | dividers, secondary-button outlines, progress tracks |
| `--color-fg` / `--color-fg-2` | `#F7F7F2` / `#A9A9B0` | primary / secondary text |
| `--color-on-fg` | `#0B0B0C` | text/icons on white and on accent fills |
| `--color-accent` | `#FFC233` | progress, selected chip, avatar, logo, playing icon, focus ring |
| `--color-danger` / `--color-success` / `--color-warning` | `#FF7A7A` / `#5BD69B` / `#FFC233` | failed / ready+finished / needs-OCR |
| `--color-off` | `#4A4A52` | switch track off, drop-zone dashed border |

- **Type:** Sora 700 (`.font-display`, −0.03em) for page (42 px), shelf (30 px),
  section (24 px), book (36/24 px) and player (30/24 px) titles and the "folio"
  wordmark; Figtree for everything else, including the read-along. Eyebrows: 12 px,
  600, uppercase, 0.08em, secondary (`.eyebrow`). Times/percentages use `.tabular`.
  `lang` is set from the book's language; CJK stacks live in `tokens.css`.
- **Shape:** pills (999 px) for every button with text, chip, input, select, switch,
  the avatar and every icon button. Radii: 4 px list covers (`rounded-xs`), 10 px
  grid covers and inputs in rows (`rounded-md`), 12 px list rows/menus/book cover
  (`rounded-lg`), 14 px sidebar items/upload rows/player cover (`rounded-xl`),
  20 px drop zone and search top-result card (`rounded-2xl`).
- **Heights:** 48 px primary pill on the book page, 40 px elsewhere; chips 34 px;
  icon buttons 40 px (36 px carousel arrows, 44 px phone); sidebar items 48 px;
  player bar 72 px; phone bottom nav and mini player 64 px. `.tap` guarantees
  44×44 on coarse pointers.
- **Glow** (main pane only, never sidebar or bar): `.bg-page-glow` default;
  `.bg-cover-glow` on the book page and `.bg-cover-glow-strong` on the player, both
  driven by the book's `cover_rgb` via `--cover-rgb` (falls back to the accent glow).

## App shell

- **Desktop (≥1024 px, `lg:`):** 240 px labelled sidebar (logo row with `Menu`
  collapse to a 72 px rail, remembered in localStorage; Home/Library/Search/Upload;
  "Add books" pill; "In progress" list, 4 max) + scrolling main pane + 72 px
  **player bar** whenever a book is loaded. The 56 px **top bar** holds the pill
  search (Enter → `/search?q=`, `/` focuses it) and the accent avatar opening the
  account menu (Profile with `manage_accounts`, Admin with the gear icon, Sign out — no theme control).
- **Tablet (768–1023 px, `md:`):** sidebar starts collapsed to the icon rail with
  11 px labels; "In progress" hidden.
- **Phone (<768 px):** 56 px header (logo, Search icon, avatar), 64 px bottom nav
  (Home, Library, Search, Upload) and a 64 px raised **mini player** above it while
  a book is loaded. Scroll areas use `.no-scrollbar`; header/nav/mini player respect
  `env(safe-area-inset-*)`.
- **Player rules:** the bar shows whenever a book is loaded (never on play/pause
  alone); app start loads the most recently played book paused at its saved
  position; `X` stops, saves and unloads; cross-device positions show "Paused ·
  last played on {device}" and a ResumePrompt. One `<audio>` element app-wide —
  bar, mini player, `/player` page and phone player all drive the same state.
  The speed text button opens the 84px vertical speed card (value + SPEED,
  210px track, step dots, halo thumb); its grid comes from config
  (`TTS_SPEED_MIN/MAX/STEP`, served by `/me/speed-options`), values always show
  at least one decimal (1.0×), it closes 3s after the last change, and the chosen
  speed is remembered per book. The phone card opens in a bottom sheet.

## Screens

- **Home `/`:** filter chips (status, languages, "Under 3 hours"; selected = accent
  fill, dark text), Continue listening carousel (176 px cards, click resumes in
  place), Next chapters grid ("Play next"), Recently added shelf. Empty: "Your
  library is empty" + white "Upload books" pill.
- **Library `/library`:** eyebrow count, Group by (default Genre) / Sort selects,
  grid/list icon pills (all remembered in localStorage), chips with counts
  (incl. "Needs attention"), genre shelves or a flat grid, list rows with ⋮.
- **Book `/books/:id`:** two columns — cover column (cover with accent bottom bar
  or corner check, title, author link, meta, clamped description, progress line,
  white pill + outlined ⋮) and pill tabs Chapters / About / Manage (Manage only for
  uploader/admin). The ⋮ menu (Mark as finished with undo toast, Reset progress,
  Narrator voice…, Go to author) is the **only** place a book's narrator is set.
  Chapter rows: played = secondary + `Check` + sr-only "Played"; playing = raised
  fill, accent `AudioLines`, "N% · M left".
- **Player `/player`:** strong cover glow; left cover + chapter title; right tabs
  UP NEXT / READ ALONG / ABOUT. Read along is lyrics-style Figtree (already-read
  32 %, current full white +4px with `aria-current`, upcoming 68 %), with a
  five-step Aa picker (Small–Huge, 17/19/22/25/28px, default Large) and a round
  auto-scroll toggle. It scrolls in its own area with a "Back to current" pill.
  Closing quotes/brackets stay with the sentence they end. The phone player is
  full-screen with a 72 px play/pause and sheet tabs; the phone read-along sheet
  uses the same five steps and toggle.
- **Search `/search?q=`:** type chips, polite result count, top-result surface
  card (author avatar or cover, white Play pill), book rows with ⋮; empty state
  offers "Upload books".
- **Upload `/upload`:** dashed `#4A4A52` drop zone with the bookmark mark and white
  "Choose files" pill; "This session" surface rows with status icon, progress bar
  (indeterminate via `.bar-indeterminate`) and pill actions.
- **Profile `/settings`:** Playback (speed select 0.9–1.15×, 5–120 s skip steppers, switches)
  and Voices (per-language pill select + 40 px outlined Preview) only. Saves are
  immediate; failures revert with an inline error.
- **Sign in `/login`:** accent glow, centered 380 px column, mark + "folio", 48 px
  pill inputs (password with `Eye`/`EyeOff`), 52 px white pill; one error alert
  that never says which field was wrong.
- **Edit details `/books/:id/edit`:** 600 px right-hand drawer over the book page
  (Manage tab behind it), focus-trapped, with an unsaved-change count and discard
  confirm. Groups: Cover (upload or link → in-drawer 2:3 crop, remove), Book
  (title, subtitle, draggable author chips, series + number), Publication
  (publisher, normalised date, language, genre), Identifiers (ISBN-10/13 checked
  on blur), Tags (chips) and Description. A lock after a label means the field is
  protected from automatic metadata; clicking it unlocks. Manage has no separate
  Cover row; **Find metadata** (provider search + apply, including the saved
  "Review metadata matches" flow) slides a 400 px results pane out beside the
  fixed 600 px form (drawer 600 → 1000 px; overlay under 1100 px) so the form
  does not move. The Manage "Edit details" pill is filled (`bg-raised`). Each result offers per-field
  accent suggestion pills with Use/Undo and "Use all" (locked fields excluded);
  used values are deferred until Save and save without locking, typed fields
  still lock. The selected result's cover is outlined in accent in place with a Use button below;
  a provider cover already applied is deduped server-side and the banner turns
  green ("Everything matches") when nothing differs. The banner occupies the
  Find button's fixed 36 px slot, so the form never moves. Manage has no Find button:
  the pane opens only from the drawer (or the Review metadata matches banner).
  The narrator is set only from the book's ⋮ menu.
- **Admin `/admin`:** Jobs / Cache / Users / Voices in the Settings column.
  Voices groups by language; assigned on-server rows show a display name,
  Preview, an Instructions pill and a default radio, plus a truncated italic
  instruction line ("No speaking instructions" when empty). The pill expands one
  4-row editor under the row at a time (label, /1000 count, draft Preview,
  Cancel, Save). The instruction is sent to the TTS engine with the book's genre
  appended; unassigned/removed voices get no editor.
- **Restyle-only screens** (Find metadata, narrator dialog, confirms, About tab,
  empty/loading/error/offline/needs-OCR/failed

Favicons and app icons are transparent (no dark tile) with the bookmark mark
scaled up to ~61 % of the canvas.
  states): raised surfaces, pill controls, white primary pills, Sora titles,
  Figtree text, accent only for selection and progress.

## Components

- **Primary pill:** `bg-fg text-on-fg font-bold rounded-full`. **Secondary:**
  transparent with 1 px `border-border`, `hover:bg-raised`. **Danger:** same with
  `border-danger text-danger`.
- **Chips:** 34 px pills, `bg-raised`; selected `bg-accent text-on-fg font-bold`
  with `aria-pressed`.
- **Selects:** `.select-pill` (native arrow hidden) + a `ChevronDown` absolutely
  positioned 16 px from the right edge, `pointer-events-none`.
- **Switch:** 44×26 pill inside a 44 px hit area; on = accent track + dark knob,
  off = `--color-off` + white knob; `role="switch"`.
- **Dialogs:** scrim `bg-bg/70`, `bg-surface` panel, 12 px radius, `--shadow-menu`,
  `font-display` title, pill buttons; Esc closes.
- **Menus:** `role="menu"`/`menuitem`, arrow keys, Esc returns focus.
- **Tabs:** `tablist`/`tab`/`tabpanel` with roving tabindex and arrow keys;
  selected tab is a white pill (book page) or white text + 2 px underline (player).
- **Cover placeholder:** flat `bg-raised` with the title in Sora; progress is a
  4 px accent bar along the cover's bottom edge, a round accent check when
  finished (`CoverProgressBadge`, `aria-hidden`; the accessible name carries it).

## Icons

`lucide-react` only, stroke width 2, through `<Icon name size>`; the four transport
icons (Play/Pause/SkipBack/SkipForward) render filled (`strokeWidth={0}`). Names
follow the HANDOFF table and are registered in `components/Icon.tsx` — no Material
Symbols, no inline SVGs, no emoji. Icon-only buttons carry an `aria-label` that
includes the current value ("Playback speed, 1.0 times").

## Motion

150–250 ms ease-out for menus, tabs and hover fills; the expanded player slides
up/down 250 ms. `prefers-reduced-motion` is neutralized globally in `tokens.css`
(including the spinning Processing/RefreshCw icon). Press states change color only,
never bounds.

## Accessibility baseline

4.5:1 text and 3:1 control contrast on the dark background (the tokens pass; accent
is never text). DB-backed sessions aside, the app is keyboard-reachable end to
end: visible 2 px accent focus ring with 2 px offset, `aria-current` on nav/tabs/
current sentence, `aria-haspopup`/`aria-expanded` menus, `aria-pressed` chips,
sr-only Played/Playing chapter text, `aria-live="polite"` for search counts, upload
summaries and toasts, skeletons for every async view and an empty state for every
list, works at 200 % zoom, 44 px touch targets on phone.
