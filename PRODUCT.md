# PRODUCT.md — Folio

> Inferred from `docs/folio-application-spec.md` and the decisions log (no interview was run). Correct anything that is wrong; this file is context for design work, not a requirement doc.

## What it is

A self-hosted web app that turns a household's EPUB/PDF/Kindle files into a shared audiobook library, read aloud by a homelab TTS engine. One small group of users (≤10), one catalog (≤5,000 books), sign-in through the company's Active Directory.

## Who uses it and where

- **Listener (primary):** on a phone, often one-handed, sometimes with the screen off or locked, resuming a book started on another device. Wants: start listening fast, know where they are, never lose their place.
- **Uploader/owner:** at a desk, after acquiring a book. Wants: drop a file, have metadata and a cover appear, fix what is wrong, hide front matter they don't want read.
- **Admin:** occasionally, to see jobs, cache, and backend health.

## Jobs to be done

1. Find the book I was listening to and continue it, with near-zero decisions.
2. Upload a file and trust it becomes a playable book.
3. Correct metadata and the cover once, and have it stick.
4. Read along while listening, on a screen that feels like a book, not a dashboard.
5. Skip the parts of a book that shouldn't be read (copyright, preface).

## Success signals

- Time from opening the app to hearing the book: a few seconds.
- Resume lands within 3 s of the stop point on any device.
- A user never sees a repeated/overlapping sentence or a dead pause at a chapter boundary.
- An edited field is still correct after a reprocess.

## Constraints

- Mobile-first (390 px), works at desktop widths, light and dark.
- Self-hosted: no CDN fonts, no analytics, no third-party UI kits.
- Accessibility is not optional: keyboard, screen reader, reduced motion, 4.5:1 contrast.
- Brand: blue→violet gradient, Outfit/Inter, 12 px cards, 999 px pills, Lucide 1.75 px icons, no emoji.
