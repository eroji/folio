# Folio logo and icon assets

Vector redraw of the Folio mark from the approved brand artwork (open book with a play button), plus every size the app needs. The wordmark is Outfit Bold converted to outlines with softened corners, so no font is needed to display it.

## Where each file goes

| File | Put it in | Used for |
| --- | --- | --- |
| `web/favicon.ico`, `web/favicon.svg` | `frontend/public/` | Browser tab icon (ICO holds 16, 32 and 48 px) |
| `web/apple-touch-icon.png` (180 px, square, opaque) | `frontend/public/` | iPhone/iPad home screen (iOS rounds the corners) |
| `web/icon-192.png`, `web/icon-512.png` | `frontend/public/` | PWA install icons |
| `web/icon-maskable-512.png` (full bleed, mark inside the safe zone) | `frontend/public/` | Android adaptive icon |
| `web/site.webmanifest` | `frontend/public/` (merge with your existing manifest if you have one) | PWA manifest: name, icons, colors |
| `web/head-snippet.html` | paste into `frontend/index.html` `<head>` | Links to all of the above |
| `svg/folio-mark.svg` | `frontend/src/assets/` | In-app logo: sidebar rail (28×32), sign-in screen (46×52) |
| `svg/folio-mark-mono.svg` | `frontend/src/assets/` | One-color uses; takes `currentColor` (the play button is cut out) |
| `svg/folio-wordmark.svg` | `frontend/src/assets/` | "Folio" text alone; takes `currentColor` |
| `svg/folio-logo-light-bg.svg`, `svg/folio-logo-dark-bg.svg` | `docs/` or `frontend/src/assets/` | Mark + wordmark lockup for light and dark backgrounds (README, about page) |
| `svg/app-icon-light.svg`, `svg/app-icon-dark.svg` | `docs/sample/` | Master app-icon artwork (rounded tile) |
| `png/*` | `docs/sample/` | Raster exports: 1024 px mark and app icons, 1200 px lockups, favicon PNGs |

## Rules

- **Colors:** blue #1F7EF6 → #2F7AF7 (left face), #5E6FF8 → #8B5CF6 (right face), periwinkle #8EA2F9 (top page), white play button. Dark tiles use ink #1E2235.
- **Clear space:** keep at least the width of the play button empty around the mark or lockup.
- **Minimum size:** mark 16 px tall (favicon), lockup 24 px tall.
- **Don't** recolor the gradient, outline the mark, add shadows, or set "Folio" in a different font next to the mark; use the outlined wordmark files.
- If you have the original vector source for the mark, prefer it; these files were redrawn to match the approved artwork.
