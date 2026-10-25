# DESIGN.md — Folio

> Inferred from the spec's Brand section and the shipped UI. The brand tokens in `frontend/src/styles/tokens.css` are the single source of truth; this file explains how to use them.

## Mode

- **App surfaces** (library, upload, book, settings, admin): *Operate*. Familiar patterns, scannability, one primary action per screen.
- **Read-along**: *Read*. Comfortable measure, generous leading, the text is the content.
- **Nothing here is Persuade.** No marketing hero, no decorative gradients beyond the brand mark and the player progress fill.

## Identity

| Token | Value | Use |
|---|---|---|
| `--brand-blue` | `#2381F7` | primary, active, focus |
| `--brand-violet` | `#8B5CF6` | gradient end, highlights |
| `--brand-gradient` | `135deg, blue → violet` | mark, primary CTA, progress fill, placeholder covers |
| `--brand-tint` | `#8EA2F9` | active-sentence tint (at low alpha), subtle accents |
| `--ink` | `#1E2235` | text on light, dark surface |
| `--surface-light` / `--surface-dark` | `#F6F7FB` / `#12141F` | page backgrounds |
| `--muted` | `#5B6275` / `#A3A9BA` | secondary text, ≥4.5:1 |

Type: **Outfit** 600–700 for display/headings, **Inter** 400–600 for UI and body. Reading text uses a **serif** stack (`--font-reading: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif`) to read like a book; no font package is added.

## Scale and rhythm

- Spacing: 4/8/12/16/24/32/48. Cards 12 px radius, pills 999 px.
- UI type: 12 label · 14 secondary · 16 body · 20 section · 24 page title · 32 hero (rare).
- Reading type: `clamp(1.05rem, 0.7rem + 1.2vw, 1.35rem)`, line-height 1.75, measure ≤ 68ch, paragraph gap 0.85em.
- Icons: Lucide, 1.75 px stroke, sizes 18/20/22/28; decorative → `aria-hidden`, icon-only controls → `aria-label`.

## Components

- **Primary button**: gradient fill, white text, 48–56 px tall, pill, one per screen.
- **Secondary**: card surface, 1 px `--line` border.
- **Book card**: 2:3 cover, title 2 lines max, author 1 line, status badge.
- **Sticky action bar** (book page): full-width, safe-area padded, above the mini player, never overlapping content padding.
- **Reader**: a page-like panel (`rounded-card`, border, paper surface) with its **own scrollbar** and serif 68 ch text; the window must not scroll when the spoken line advances.
- **Mini player (Plex-like)**: 64–72 px; 56 px cover with the **percent badge overlaid bottom-left**; title, chapter, `elapsed / total`; previous chapter, −skip, play, +skip, next chapter, stop (desktop adds speed, phones keep prev/play/next). No banner above it.
- **Player**: full-width native chapter `<select>` flanked by previous/next arrows; chapter title is the heading; transport row dominates; secondary controls in one quiet row.
- **Book settings** (admin/uploader): a disclosure holding chapter inclusion switches and the pronunciation-rules table, never inline clutter on the book page.
- **Voice picker**: language voices only, first available preselected, no "Default", no "Show all", never the engine's `tts` fallback.
- **Destructive actions**: reset progress opens a confirmation dialog and restarts from the beginning.
- **Sleep timer**: menu with `Off / 15 / 30 / 45 / 60 minutes / End of chapter`, checkmark on active, trigger shows the active choice.
- **Chapter manager**: disclosure with an "Include in playback" switch per chapter; excluded chapters live in a secondary disclosure, never deleted.

## Interaction

- Press states change color/opacity only, never bounds.
- Focus: 2 px `--brand-blue` ring with 2 px offset, on every control.
- Motion: 150–250 ms ease; honor `prefers-reduced-motion` (auto-scroll becomes instant).
- Loading: skeletons for grids, "Preparing audio…" for synthesis, never a spinner over an empty screen.
- Errors: inline, human, with the next action ("Couldn't generate this part — Retry").

## Accessibility baseline

Keyboard reachable, visible focus, 44×44 targets, 4.5:1 text in both themes, 3:1 for meaningful icons, `aria-live` only for short status, `aria-live="off"` on the scrolling read-along, escape closes sheets/menus, sticky bars do not obscure focused controls.
