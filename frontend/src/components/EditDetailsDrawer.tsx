/** Edit details drawer (handoff "Find metadata inside the drawer"): a right-side
 * drawer over the book page. "Find metadata" slides a 400 px results pane out
 * to the left of the fixed 600 px form, so nothing in the form moves. The selected result offers per-field suggestion
 * pills; "Use" fills the field and marks it as metadata-sourced (saved via
 * metadata_fields so it is not locked), "Undo" restores the previous value.
 * Nothing is written until Save; a used cover is PUT first, then the PATCH.
 * Under 1100 px the pane overlays the form and closes after a pick. Groups
 * (Cover, Book, Publication, Identifiers, Tags, Description), per-field locks
 * backed by POST /books/{id}/unlock and the in-drawer 2:3 crop are unchanged. */
import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import {
  useDeleteCover,
  useMetadataSearch,
  useSetCoverUrl,
  useUnlockField,
  useUpdateBook,
  useUploadCover,
  type BookPatch,
  type BookSavePatch,
} from "../api/metadata";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import type { Book, Candidate } from "../api/types";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
];
const OTHER = "__other__";

/** Mirrors backend config.GENRES (handoff §5.1): suggestions, free text allowed. */
export const GENRES = [
  "Classics",
  "Fiction",
  "Science Fiction",
  "Fantasy",
  "Mystery",
  "Thriller",
  "Horror",
  "Romance",
  "Historical Fiction",
  "Myth & epic",
  "Poetry",
  "Drama",
  "Biography",
  "History",
  "Science",
  "Philosophy",
  "Nonfiction",
  "Children",
];

/** Fields the server can protect from automatic updates (locked_fields keys). */
export const LOCKABLE_FIELDS = [
  "title",
  "subtitle",
  "authors",
  "series",
  "series_index",
  "publisher",
  "published_date",
  "language",
  "isbn10",
  "isbn13",
  "tags",
  "genre",
  "description",
] as const;

export function isbn10Valid(raw: string): boolean {
  const digits = raw.replace(/[-\s]/g, "");
  if (!/^\d{9}[\dXx]$/.test(digits)) return false;
  return [...digits].reduce((sum, char, i) => sum + (char === "X" || char === "x" ? 10 : Number(char)) * (10 - i), 0) % 11 === 0;
}

export function isbn13Valid(raw: string): boolean {
  const digits = raw.replace(/[-\s]/g, "");
  if (!/^\d{13}$/.test(digits)) return false;
  return [...digits].reduce((sum, char, i) => sum + Number(char) * (i % 2 === 1 ? 3 : 1), 0) % 10 === 0;
}

/** Stored timestamps ("2008-01-01T05:00:00+00:00") display as dates ("2008-01-01"). */
export function normalizeDate(value: string): string {
  return value.replace(/[T ].*$/, "").trim();
}

interface Form {
  title: string;
  subtitle: string;
  authors: string[];
  series: string;
  seriesIndex: string;
  description: string;
  publisher: string;
  publishedDate: string;
  language: string;
  otherLanguage: string;
  isbn10: string;
  isbn13: string;
  tags: string[];
  genre: string;
  otherGenre: string;
}

export function fromBook(book: Book): Form {
  const known = LANGUAGES.some((entry) => entry.code === book.language);
  return {
    title: book.title,
    subtitle: book.subtitle ?? "",
    authors: [...book.authors],
    series: book.series ?? "",
    seriesIndex: book.series_index == null ? "" : String(book.series_index),
    description: book.description ?? "",
    publisher: book.publisher ?? "",
    publishedDate: normalizeDate(book.published_date ?? ""),
    language: known ? book.language : OTHER,
    otherLanguage: known ? "" : book.language,
    isbn10: book.isbn10 ?? "",
    isbn13: book.isbn13 ?? "",
    tags: [...book.tags],
    genre: book.genre ?? "",
    otherGenre: book.genre && !GENRES.includes(book.genre) ? book.genre : "",
  };
}

const trimmed = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** Only the fields the user actually changed; empty strings clear nullable fields. */
export function buildPatch(form: Form, book: Book): BookPatch {
  const patch: BookPatch = {};
  const text = <K extends "subtitle" | "series" | "description" | "publisher" | "isbn10" | "isbn13">(
    key: K,
    value: string | null,
  ) => {
    // Compare trimmed values: leading/trailing whitespace in stored metadata
    // (descriptions routinely start with a newline) is not a user edit.
    const stored = book[key];
    if ((value ?? "") !== (stored == null ? "" : trimmed(stored) ?? "")) patch[key] = value;
  };
  text("subtitle", trimmed(form.subtitle));
  text("series", trimmed(form.series));
  text("description", trimmed(form.description));
  text("publisher", trimmed(form.publisher));
  text("isbn10", trimmed(form.isbn10));
  text("isbn13", trimmed(form.isbn13));
  // Compare the normalised dates so a stored timestamp is not a "change".
  const published = trimmed(normalizeDate(form.publishedDate));
  if ((published ?? "") !== normalizeDate(book.published_date ?? "")) patch.published_date = published;
  const title = trimmed(form.title);
  if (title && title !== book.title) patch.title = title; // empty title is blocked by validation
  const language = form.language === OTHER ? trimmed(form.otherLanguage) : form.language;
  if (language && language !== book.language) patch.language = language;
  const authors = form.authors.map((author) => author.trim()).filter(Boolean);
  if (authors.join("\u0000") !== book.authors.join("\u0000")) patch.authors = authors;
  const tags = form.tags.map((tag) => tag.trim()).filter(Boolean);
  if (tags.join("\u0000") !== book.tags.join("\u0000")) patch.tags = tags;
  const genre = form.genre === OTHER ? trimmed(form.otherGenre) : (form.genre || null);
  if (genre !== (book.genre ?? null)) patch.genre = genre;
  const index = form.seriesIndex.trim() === "" ? null : Number(form.seriesIndex);
  if (index !== book.series_index) patch.series_index = index;
  return patch;
}

/* ---- find-metadata suggestions ---- */

const SOURCES: Record<string, string> = { openlibrary: "Open Library", googlebooks: "Google Books" };
const sourceName = (source: string): string => SOURCES[source] ?? source;

/** Provider descriptions carry HTML; suggestion pills and the form take plain text.
 * Block tags become newlines so the pill can show the first line. */
function plainText(html: string): string {
  const withBreaks = html.replace(/<\/(?:p|div|h[1-6]|li)>|<br[^>]*>/gi, "\n");
  const text = new DOMParser().parseFromString(withBreaks, "text/html").body.textContent ?? withBreaks;
  return text.replace(/[ \t]+/g, " ").trim();
}

/** One provider field → form field mapping. `text` null/empty or `same` means
 * no suggestion; `keys` are the Form keys Use writes (and typing clears). */
interface SuggestionDef {
  label: string;
  keys: (keyof Form)[];
  text: (candidate: Candidate) => string | null;
  apply: (candidate: Candidate, form: Form) => Partial<Form>;
  same: (candidate: Candidate, form: Form) => boolean;
}

const eqTrim = (a: string, b: string | null): boolean => a.trim() === (b ?? "").trim();

const SUGGESTIONS: Record<string, SuggestionDef> = {
  title: {
    label: "Title",
    keys: ["title"],
    text: (c) => c.title.trim() || null,
    apply: (c) => ({ title: c.title }),
    same: (c, f) => eqTrim(f.title, c.title),
  },
  authors: {
    label: "Authors",
    keys: ["authors"],
    text: (c) => (c.authors.length > 0 ? c.authors.join(", ") : null),
    apply: (c) => ({ authors: [...c.authors] }),
    same: (c, f) => f.authors.join("\u0000") === c.authors.join("\u0000"),
  },
  series: {
    label: "Series",
    keys: ["series"],
    text: (c) => c.series,
    apply: (c) => ({ series: c.series ?? "" }),
    same: (c, f) => eqTrim(f.series, c.series),
  },
  series_index: {
    label: "Number",
    keys: ["seriesIndex"],
    text: (c) => (c.series_index == null ? null : String(c.series_index)),
    apply: (c) => ({ seriesIndex: String(c.series_index) }),
    same: (c, f) => (f.seriesIndex.trim() === "" ? null : Number(f.seriesIndex)) === c.series_index,
  },
  published_date: {
    label: "Published",
    keys: ["publishedDate"],
    text: (c) => (c.published_date ? normalizeDate(c.published_date) : null),
    apply: (c) => ({ publishedDate: normalizeDate(c.published_date ?? "") }),
    same: (c, f) => normalizeDate(f.publishedDate) === normalizeDate(c.published_date ?? ""),
  },
  publisher: {
    label: "Publisher",
    keys: ["publisher"],
    text: (c) => c.publisher,
    apply: (c) => ({ publisher: c.publisher ?? "" }),
    same: (c, f) => eqTrim(f.publisher, c.publisher),
  },
  description: {
    label: "Description",
    keys: ["description"],
    text: (c) => (c.description ? plainText(c.description) : null),
    apply: (c) => ({ description: plainText(c.description ?? "") }),
    same: (c, f) => eqTrim(f.description, c.description ? plainText(c.description) : ""),
  },
  language: {
    label: "Language",
    keys: ["language", "otherLanguage"],
    text: (c) => c.language,
    apply: (c) => {
      const value = (c.language ?? "").trim();
      return LANGUAGES.some((entry) => entry.code === value)
        ? { language: value, otherLanguage: "" }
        : { language: OTHER, otherLanguage: value };
    },
    same: (c, f) => (f.language === OTHER ? f.otherLanguage.trim() : f.language) === (c.language ?? "").trim(),
  },
  genre: {
    label: "Genre",
    keys: ["genre", "otherGenre"],
    text: (c) => c.suggested_genre ?? null,
    apply: (c) => {
      const value = (c.suggested_genre ?? "").trim();
      return GENRES.includes(value) ? { genre: value, otherGenre: "" } : { genre: OTHER, otherGenre: value };
    },
    same: (c, f) => (f.genre === OTHER ? f.otherGenre.trim() : f.genre) === (c.suggested_genre ?? "").trim(),
  },
  isbn10: {
    label: "ISBN-10",
    keys: ["isbn10"],
    text: (c) => c.isbn10,
    apply: (c) => ({ isbn10: c.isbn10 ?? "" }),
    same: (c, f) => eqTrim(f.isbn10, c.isbn10),
  },
  isbn13: {
    label: "ISBN-13",
    keys: ["isbn13"],
    text: (c) => c.isbn13,
    apply: (c) => ({ isbn13: c.isbn13 ?? "" }),
    same: (c, f) => eqTrim(f.isbn13, c.isbn13),
  },
  tags: {
    label: "Tags",
    keys: ["tags"],
    text: (c) => (c.tags.length > 0 ? c.tags.join(", ") : null),
    apply: (c) => ({ tags: [...c.tags] }),
    same: (c, f) => f.tags.join("\u0000") === c.tags.join("\u0000"),
  },
};

/* ---- cover crop (same pinned export size as the old CoverEditor) ---- */

const VW = 240;
const VH = 360; // 2:3 crop viewport, CSS px
const OUT_W = 1200;
const OUT_H = 1800; // pinned export size
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

interface Pan {
  x: number;
  y: number;
}

function fitScale(img: HTMLImageElement): number {
  return Math.max(VW / img.naturalWidth, VH / img.naturalHeight);
}

function clampPan(next: Pan, img: HTMLImageElement, scale: number): Pan {
  return {
    x: Math.min(0, Math.max(VW - img.naturalWidth * scale, next.x)),
    y: Math.min(0, Math.max(VH - img.naturalHeight * scale, next.y)),
  };
}

/** Render the current view at 1200x1800 and encode WebP.
 * ponytail: browsers without WebP encoding fall back to PNG here; the server
 * magic-byte-checks and accepts both. */
function cropToWebp(img: HTMLImageElement, zoom: number, pan: Pan): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  const scale = fitScale(img) * zoom;
  ctx.drawImage(img, -pan.x / scale, -pan.y / scale, VW / scale, VH / scale, 0, 0, OUT_W, OUT_H);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/webp", 0.9));
}

/* ---- shared shapes ---- */

const inputPill = "tap h-11 w-full rounded-full border border-border bg-raised px-4 text-md";
const outlinePill =
  "tap inline-flex h-9 items-center gap-2 rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const footerPill =
  "tap inline-flex h-11 items-center justify-center rounded-full border border-border bg-transparent px-4 text-md font-semibold text-fg hover:bg-raised";
const footerPrimary =
  "tap inline-flex h-11 items-center justify-center rounded-full bg-fg px-[18px] text-md font-bold text-on-fg disabled:opacity-50";
const selectPill = "select-pill tap h-11 w-full border border-border bg-raised text-md text-fg";
const selectChevron = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";
/** Accent-tinted suggestion pill / summary bar (handoff: accent at ~10–12%). */
const accentTint = "border-accent/30 bg-accent/10";
const whitePill = "tap inline-flex items-center justify-center rounded-full bg-fg font-bold text-on-fg";

/** 13px/600 label with a fixed 24px row so side-by-side fields line up;
 * an accent lock button appears while the field is protected. */
function LockButton({ name, onUnlock }: { name: string; onUnlock: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      title="Protected from automatic updates · click to unlock"
      aria-label={`${name} is protected from automatic updates. Unlock`}
      className="grid size-6 shrink-0 place-items-center rounded-full text-accent hover:bg-raised"
    >
      <Icon name="Lock" size={14} />
    </button>
  );
}

function FieldLabel({ name, locked, onUnlock }: { name: string; locked: boolean; onUnlock: () => void }) {
  return (
    <span className="flex min-h-6 items-center gap-1 text-[13px] font-semibold">
      {name}
      {locked && <LockButton name={name} onUnlock={onUnlock} />}
    </span>
  );
}

function Field({
  name,
  locked,
  onUnlock,
  children,
}: {
  name: string;
  locked: boolean;
  onUnlock: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel name={name} locked={locked} onUnlock={onUnlock} />
      {children}
    </div>
  );
}

function Group({
  title,
  children,
  divider = true,
  action,
}: {
  title: string;
  children: ReactNode;
  /** Off for the first group, which follows the Find metadata pill. */
  divider?: boolean;
  /** Optional control beside the eyebrow (e.g. the Description lock). */
  action?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={clsx("flex flex-col gap-3.5 py-5", divider && "border-t border-border")}
    >
      <div className="flex min-h-6 items-center gap-1.5">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Chip field: type + Enter or comma adds, X removes; authors also drag-reorder. */
function ChipField({
  label,
  noun,
  chips,
  onChange,
  placeholder,
  reorderable,
  hint,
  locked,
  onUnlock,
}: {
  label: string;
  noun: string;
  chips: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  reorderable?: boolean;
  hint?: string;
  locked: boolean;
  onUnlock: () => void;
}) {
  const [draft, setDraft] = useState("");
  const dragFrom = useRef<number | null>(null);
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    onChange([...chips, value]);
    setDraft("");
  };
  const onDrop = (index: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === index) return;
    const next = [...chips];
    const [moved] = next.splice(from, 1);
    next.splice(index, 0, moved!);
    onChange(next);
  };
  return (
    <Field name={label} locked={locked} onUnlock={onUnlock}>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[22px] border border-border bg-bg p-1.5">
        {chips.map((chip, index) => (
          <span
            key={`${chip}-${index}`}
            draggable={reorderable}
            onDragStart={() => {
              dragFrom.current = index;
            }}
            onDragOver={(event: ReactDragEvent) => {
              if (reorderable) event.preventDefault();
            }}
            onDrop={(event: ReactDragEvent) => {
              event.preventDefault();
              onDrop(index);
            }}
            className={clsx(
              "inline-flex h-9 items-center gap-1 rounded-full bg-raised pl-2 pr-1 text-base font-medium",
              reorderable && "cursor-grab",
            )}
          >
            {reorderable && <Icon name="GripVertical" size={16} className="text-fg-2" />}
            {chip}
            <button
              type="button"
              aria-label={`Remove ${noun} ${chip}`}
              onClick={() => onChange(chips.filter((_, i) => i !== index))}
              className="grid size-7 place-items-center rounded-full text-fg-2 hover:text-fg"
            >
              <Icon name="X" size={14} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          aria-label={`Add ${label.toLowerCase()}`}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          className="h-9 min-w-24 flex-1 border-0 bg-transparent px-2 text-md outline-none"
        />
      </div>
      {hint && <p className="text-xs text-fg-2">{hint}</p>}
    </Field>
  );
}

/* ---- cover group ---- */

interface CropSource {
  src: string;
  from: "file" | "url";
}

interface CoverPreview {
  url: string;
  source: string;
}

function CoverGroup({
  book,
  stagedCover,
  onDeclineCover,
  onCoverPicked,
}: {
  book: Book;
  stagedCover?: CoverPreview;
  onDeclineCover: () => void;
  onCoverPicked: () => void;
}) {
  const upload = useUploadCover(book.id);
  const fromUrl = useSetCoverUrl(book.id);
  const removeCover = useDeleteCover(book.id);
  const [crop, setCrop] = useState<CropSource | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [fileError, setFileError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; pan: Pan } | null>(null);

  useEffect(() => {
    if (!crop) {
      setImg(null);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const scale = fitScale(image);
      setZoom(1);
      setPan({ x: (VW - image.naturalWidth * scale) / 2, y: (VH - image.naturalHeight * scale) / 2 });
      setImg(image);
    };
    image.src = crop.src;
  }, [crop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scale = fitScale(img) * zoom;
    ctx.clearRect(0, 0, VW, VH);
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, pan.x, pan.y, img.naturalWidth * scale, img.naturalHeight * scale);
  }, [img, zoom, pan]);

  function pickFile(candidate: File | null) {
    if (!candidate) return;
    if (!TYPES.includes(candidate.type)) {
      setFileError("Covers must be JPEG, PNG or WebP images.");
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setFileError("Cover image is larger than 10 MB.");
      return;
    }
    setFileError(null);
    setCrop({ src: URL.createObjectURL(candidate), from: "file" });
  }

  const error = fileError ?? upload.error?.message ?? fromUrl.error?.message ?? removeCover.error?.message ?? null;

  if (crop) {
    return (
      <Group title="Cover" divider={false}>
        <div className="flex flex-wrap items-start gap-5">
          <canvas
            ref={canvasRef}
            width={VW}
            height={VH}
            aria-label="Crop area. Drag to move the image."
            className="aspect-[2/3] w-60 touch-none rounded-md bg-raised"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, pan };
            }}
            onPointerMove={(event) => {
              if (!drag.current || !img) return;
              const scale = fitScale(img) * zoom;
              setPan(
                clampPan(
                  { x: drag.current.pan.x + event.clientX - drag.current.x, y: drag.current.pan.y + event.clientY - drag.current.y },
                  img,
                  scale,
                ),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          />
          <div className="flex min-w-40 flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1 text-base font-medium">
              Zoom
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setZoom(next);
                  setPan((current) => (img ? clampPan(current, img, fitScale(img) * next) : current));
                }}
                className="accent-accent"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!img || upload.isPending}
                onClick={() => {
                  if (!img) return;
                  void cropToWebp(img, zoom, pan).then((blob) => {
                    if (!blob) return;
                    upload.mutate(
                      { file: blob, filename: "cover.webp" },
                      {
                        onSuccess: () => {
                          onCoverPicked();
                          if (crop.from === "file") URL.revokeObjectURL(crop.src);
                          setCrop(null);
                        },
                      },
                    );
                  });
                }}
                className={footerPrimary}
              >
                Use cover
              </button>
              <button
                type="button"
                onClick={() => {
                  if (crop.from === "file") URL.revokeObjectURL(crop.src);
                  setCrop(null);
                }}
                className={footerPill}
              >
                Back
              </button>
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger bg-bg px-3 py-2 text-sm text-danger">
            <Icon name="TriangleAlert" size={16} />
            {error}
          </p>
        )}
      </Group>
    );
  }

  return (
    <Group title="Cover" divider={false}>
      <div className="flex flex-wrap items-center gap-5">
        {stagedCover ? (
          <span className="relative block aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-md bg-raised">
            <img src={stagedCover.url} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={onDeclineCover}
              aria-label="Don't use the suggested cover"
              title="Don't use the suggested cover"
              className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-bg/85 text-fg hover:bg-bg"
            >
              <Icon name="X" size={14} />
            </button>
          </span>
        ) : book.cover_url ? (
          <img src={book.cover_url} alt="" className="aspect-[2/3] w-24 shrink-0 rounded-md bg-raised object-cover" />
        ) : (
          <div className="grid aspect-[2/3] w-24 shrink-0 place-items-center rounded-md border border-border bg-raised text-sm text-fg-2">
            No cover
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap gap-2">
            <label className={clsx(outlinePill, "cursor-pointer")}>
              <Icon name="Upload" size={18} />
              Upload image
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-label="Upload cover image"
                onChange={(event) => {
                  pickFile(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </label>
            <button type="button" onClick={() => setLinkOpen((open) => !open)} className={outlinePill} aria-expanded={linkOpen}>
              <Icon name="Link" size={18} />
              Paste link
            </button>
          </div>
          {linkOpen && (
            <div className="flex gap-2">
              <input
                type="url"
                aria-label="Cover image URL"
                placeholder="https://example.org/cover.jpg"
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                className={inputPill}
              />
              <button
                type="button"
                className={outlinePill}
                disabled={!urlInput.trim() || fromUrl.isPending}
                onClick={() =>
                  fromUrl.mutate(urlInput.trim(), {
                    onSuccess: (data) => {
                      onCoverPicked();
                      setLinkOpen(false);
                      setUrlInput("");
                      if (data.cover_url) setCrop({ src: data.cover_url, from: "url" });
                    },
                  })
                }
              >
                Fetch
              </button>
            </div>
          )}
          <p className="text-xs text-fg-2">JPG, PNG or WebP. You’ll crop it to 2:3 next.</p>
          {!stagedCover && (
            <button
              type="button"
              disabled={!book.cover_url || removeCover.isPending}
              onClick={() => removeCover.mutate()}
              className="tap self-start py-1 text-base font-semibold text-fg-2 underline hover:text-fg disabled:opacity-50"
            >
              Remove cover
            </button>
          )}
          {stagedCover && (
            <span className="text-xs text-fg-2">Suggested cover from {stagedCover.source} · saves when you press Save</span>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger bg-bg px-3 py-2 text-sm text-danger">
          <Icon name="TriangleAlert" size={16} />
          {error}
        </p>
      )}
    </Group>
  );
}

/* ---- the drawer ---- */

const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function EditDetailsDrawer({
  book,
  onClose,
  initialReviewItems,
}: {
  book: Book;
  onClose: () => void;
  /** "Review metadata matches" opens the pane with these results preloaded. */
  initialReviewItems?: Candidate[];
}) {
  const [form, setForm] = useState<Form>(() => fromBook(book));
  const [isbnTouched, setIsbnTouched] = useState({ isbn10: false, isbn13: false });
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(Boolean(initialReviewItems?.length));
  const [items, setItems] = useState<Candidate[] | null>(initialReviewItems ?? null);
  const [selected, setSelected] = useState(initialReviewItems?.length ? 0 : -1);
  // The result driving the suggestion pills; null once the pane is closed with X.
  const [suggestion, setSuggestion] = useState<Candidate | null>(initialReviewItems?.[0] ?? null);
  // field → where it came from and the form to restore on Undo.
  const [usedMeta, setUsedMeta] = useState<Record<string, { source: string; prev: Form }>>({});
  // Deferred cover: the selected result's cover is shown in place until Save
  // PUTs it; the X on the preview declines it.
  const [usedCover, setUsedCover] = useState<{ url: string; source: string } | null>(null);
  const [declinedCovers, setDeclinedCovers] = useState<string[]>([]);
  const [query, setQuery] = useState(`${book.title} ${book.authors[0] ?? ""}`.trim());
  const [isbn, setIsbn] = useState(book.isbn13 ?? book.isbn10 ?? "");
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const update = useUpdateBook(book.id);
  const unlock = useUnlockField(book.id);
  const search = useMetadataSearch(book.id);
  const coverPut = useSetCoverUrl(book.id);
  const wide = useMediaQuery("(min-width: 1100px)");

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Latest values for the pane's auto-search without re-running the effect.
  const live = useRef({ query, isbn, items, search });
  live.current = { query, isbn, items, search };

  function runSearch() {
    const { query: q, isbn: rawIsbn, search: mutation } = live.current;
    mutation.mutate(
      { q: q.trim(), isbn: rawIsbn.trim() || undefined },
      {
        onSuccess: (data) => {
          setItems(data.items);
          // The best match is selected automatically (server sorts by score).
          const best = data.items.reduce((b, item, i) => (item.score > (data.items[b]?.score ?? -1) ? i : b), 0);
          setSelected(best);
          setSuggestion(data.items[best] ?? null);
        },
      },
    );
  }

  // Searching runs automatically whenever the pane opens without results
  // (Find metadata pill, Manage → Find metadata); preloaded review items skip it.
  useEffect(() => {
    if (findOpen && live.current.items === null) runSearch();
  }, [findOpen]);

  // The selected result's cover is previewed in the cover slot immediately
  // (unless the server says it is already applied, or the user declined it).
  useEffect(() => {
    if (!suggestion) return;
    const url = suggestion.cover_url;
    if (!url || suggestion.cover_applied || declinedCovers.includes(url)) {
      setUsedCover(null);
      return;
    }
    setUsedCover((current) =>
      current?.url === url ? current : { url, source: sourceName(suggestion.source) },
    );
  }, [suggestion, declinedCovers]);

  function declineCover() {
    if (usedCover) {
      setDeclinedCovers((current) =>
        current.includes(usedCover.url) ? current : [...current, usedCover.url],
      );
    }
    setUsedCover(null);
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Typing makes the field hand-edited again: drop the metadata marker.
    setUsedMeta((current) => {
      const field = Object.keys(current).find((name) => SUGGESTIONS[name]?.keys.includes(key));
      if (!field) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  };

  const patch = buildPatch(form, book);
  const locked = new Set((book.locked_fields ?? []).filter((field) => !unlocked.includes(field)));
  const isLocked = (field: string) => locked.has(field);
  function unlockField(field: (typeof LOCKABLE_FIELDS)[number]) {
    unlock.mutate(field, { onSuccess: () => setUnlocked((current) => [...current, field]) });
  }

  const usedFields = Object.keys(usedMeta);
  const changeCount = Object.keys(patch).length + (usedCover ? 1 : 0);

  const titleError = form.title.trim() === "" ? "Title is required." : null;
  const isbn10Error = form.isbn10.trim() !== "" && !isbn10Valid(form.isbn10) ? "This ISBN-10 checksum is not valid." : null;
  const isbn13Error = form.isbn13.trim() !== "" && !isbn13Valid(form.isbn13) ? "This ISBN-13 checksum is not valid." : null;
  const indexError = form.seriesIndex.trim() !== "" && Number.isNaN(Number(form.seriesIndex)) ? "Series number must be a number." : null;
  const languageError = form.language === OTHER && form.otherLanguage.trim() === "" ? "Enter a language code." : null;
  const isbnInvalid = (isbnTouched.isbn10 && isbn10Error) || (isbnTouched.isbn13 && isbn13Error);
  const invalid = Boolean(titleError ?? isbnInvalid ?? indexError ?? languageError);

  function applySuggestion(field: string) {
    if (!suggestion) return;
    const def = SUGGESTIONS[field]!;
    const source = sourceName(suggestion.source);
    setUsedMeta((current) => ({ ...current, [field]: { source, prev: form } }));
    setForm((current) => ({ ...current, ...def.apply(suggestion, current) }));
  }

  function undoField(field: string) {
    const marker = usedMeta[field];
    if (!marker) return;
    setForm((current) => {
      const next = { ...current } as Record<string, unknown>;
      for (const key of SUGGESTIONS[field]!.keys) next[key] = marker.prev[key];
      return next as unknown as Form;
    });
    setUsedMeta((current) => {
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  }

  /** Applies every differing suggestion except locked fields (handoff: locked
   * fields need an explicit Use) and remembers the candidate's cover. */
  function useAll() {
    if (!suggestion) return;
    const source = sourceName(suggestion.source);
    let next = form;
    const markers = { ...usedMeta };
    for (const [field, def] of Object.entries(SUGGESTIONS)) {
      if (isLocked(field)) continue;
      if (!def.text(suggestion) || def.same(suggestion, next)) continue;
      markers[field] = { source, prev: form };
      next = { ...next, ...def.apply(suggestion, next) };
    }
    setForm(next);
    setUsedMeta(markers);
  }

  function selectRow(index: number) {
    setSelected(index);
    setSuggestion(items?.[index] ?? null);
    if (!wide) setFindOpen(false); // overlay mode: picking reveals the suggestions
  }

  /** X (or Esc): collapse the pane and drop unused suggestions; used values and
   * their ✓ lines stay in the form. */
  function closePane() {
    setFindOpen(false);
    setSuggestion(null);
  }

  const pillShown = (field: string): boolean => {
    if (usedMeta[field] || !suggestion) return false;
    const def = SUGGESTIONS[field]!;
    return Boolean(def.text(suggestion)) && !def.same(suggestion, form);
  };
  const suggestionCount =
    usedFields.length + Object.keys(SUGGESTIONS).filter(pillShown).length + (usedCover ? 1 : 0);

  /** Per-field suggestion UI: the pill, or the "✓ From … · Undo" line. */
  function suggestionUi(field: string): ReactNode {
    const def = SUGGESTIONS[field]!;
    const marker = usedMeta[field];
    if (marker) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-fg-2">
          <Icon name="Check" size={13} className="text-accent" />
          From {marker.source}
          <button type="button" onClick={() => undoField(field)} aria-label={`Undo ${def.label}`} className="font-semibold text-fg underline">
            Undo
          </button>
        </span>
      );
    }
    if (!suggestion) return null;
    const value = def.text(suggestion);
    if (!value || def.same(suggestion, form)) return null;
    const shown =
      field === "description"
        ? `${value.split("\n")[0]} · ${value.split(/\s+/).filter(Boolean).length} words`
        : value;
    return (
      <div className={clsx("flex min-h-9 items-center justify-between gap-2.5 rounded-lg py-0.5 pr-1 pl-3.5", accentTint)}>
        <span className="min-w-0 truncate text-base">
          <span className="text-fg-2">{sourceName(suggestion.source)}: </span>
          <span className="font-semibold">{shown}</span>
        </span>
        <button type="button" onClick={() => applySuggestion(field)} aria-label={`Use ${shown}`} className={clsx(whitePill, "h-7 shrink-0 px-3 text-base")}>
          Use
        </button>
      </div>
    );
  }

  function attemptClose() {
    if (changeCount > 0) setDiscardOpen(true);
    else onClose();
  }

  function save() {
    if (invalid || changeCount === 0) return;
    const metadataFields = usedFields.filter((field) => field in patch);
    const body: BookSavePatch = metadataFields.length > 0 ? { ...patch, metadata_fields: metadataFields } : patch;
    if (usedCover) {
      // The metadata cover goes through PUT /cover-url first; on failure the
      // drawer stays open with the error.
      coverPut.mutate(usedCover.url, { onSuccess: () => update.mutate(body, { onSuccess: onClose }) });
      return;
    }
    update.mutate(body, { onSuccess: onClose });
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      if (discardOpen) return; // the confirm dialog handles its own dismissal
      event.stopPropagation();
      if (findOpen) closePane();
      else attemptClose();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const list = [...nodes].filter(
      (node) => !node.hidden && !("disabled" in node && (node as HTMLButtonElement).disabled),
    );
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const genreOptions = book.genre && !GENRES.includes(book.genre) ? [...GENRES, book.genre] : GENRES;
  const sourceLabel = suggestion ? sourceName(suggestion.source) : "";
  const suggestionYear = suggestion?.published_date ? normalizeDate(suggestion.published_date).slice(0, 4) : "";
  const statusNames = [...new Set((items ?? []).map((item) => sourceName(item.source)))].sort();
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/62"
      onClick={(event) => {
        if (event.target === event.currentTarget) attemptClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-details-title"
        onKeyDown={onKeyDown}
        className={clsx(
          "drawer-in relative flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface shadow-[-24px_0_60px_rgb(0_0_0/0.5)] transition-[max-width] duration-[250ms]",
          findOpen && wide ? "max-w-[1000px]" : "max-w-[600px]",
        )}
      >
        <div className="flex min-h-0 flex-1 justify-end">
          {findOpen && (
            <section
              role="region"
              aria-label="Find metadata"
              className={clsx(
                "find-pane-in flex h-full w-[400px] max-w-full shrink-0 flex-col border-r border-border bg-bg",
                !wide && "absolute inset-y-0 left-0 z-10",
              )}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 pt-[22px] pr-4 pb-1 pl-6">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h3 className="font-display text-xl">Find metadata</h3>
                  <span className="text-[13px] text-fg-2">Pick a result, then use the suggestions in the form.</span>
                </div>
                <button
                  type="button"
                  aria-label="Close find metadata"
                  onClick={closePane}
                  className="tap grid size-9 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-raised"
                >
                  <Icon name="X" size={20} />
                </button>
              </div>
              <div className="flex shrink-0 flex-col gap-2.5 px-6 pb-4">
                <label className="relative block">
                  <Icon name="Search" size={18} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-2" />
                  <input
                    type="search"
                    aria-label="Title or author"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        runSearch();
                      }
                    }}
                    className="tap h-11 w-full rounded-full border-2 border-accent bg-raised pr-4 pl-10 text-base"
                  />
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    aria-label="ISBN"
                    placeholder="ISBN (optional)"
                    value={isbn}
                    onChange={(event) => setIsbn(event.target.value)}
                    className="tap h-10 min-w-0 flex-1 rounded-full border border-border bg-raised px-4 text-base"
                  />
                  <button
                    type="button"
                    onClick={runSearch}
                    disabled={search.isPending}
                    className={clsx(whitePill, "h-10 shrink-0 px-[18px] text-base")}
                  >
                    Search
                  </button>
                </div>
                {search.isError ? (
                  <p role="alert" className="flex items-center gap-2 text-sm text-danger">
                    <Icon name="TriangleAlert" size={16} />
                    The metadata providers could not be reached. {search.error.message}
                  </p>
                ) : (
                  items && (
                    <p role="status" className="text-xs text-fg-2">
                      {items.length === 0
                        ? "No results"
                        : `${items.length} result${items.length === 1 ? "" : "s"}${
                            statusNames.length > 0 ? ` from ${statusNames.join(" and ")}` : ""
                          }`}
                    </p>
                  )
                )}
              </div>
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                {items?.map((item, index) => (
                  <button
                    key={`${item.source}-${index}`}
                    type="button"
                    aria-pressed={index === selected}
                    onClick={() => selectRow(index)}
                    className={clsx(
                      "tap flex w-full items-center gap-3 rounded-lg p-2.5 text-left",
                      index === selected ? "bg-raised" : "hover:bg-raised",
                    )}
                  >
                    {item.cover_url ? (
                      <img src={item.cover_url} alt="" loading="lazy" className="aspect-[2/3] w-10 shrink-0 rounded-xs bg-raised object-cover" />
                    ) : (
                      <div className="aspect-[2/3] w-10 shrink-0 rounded-xs bg-raised" aria-hidden />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-base font-semibold">{item.title}</span>
                      <span className="truncate text-xs text-fg-2">
                        {[item.authors.join(", "), item.published_date?.slice(0, 4), sourceName(item.source)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular font-bold text-fg-2">{Math.round(item.score * 100)}%</span>
                    {index === selected && <Icon name="Check" size={20} className="shrink-0 text-accent" />}
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="flex h-full w-full max-w-[600px] min-w-0 shrink-0 flex-col">
            <header className="flex shrink-0 items-start justify-between gap-3 pt-[18px] pr-5 pb-3.5 pl-7">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 id="edit-details-title" className="font-display text-xl">
                  Edit details
                </h2>
                <span className="text-[13px] text-fg-2">
                  Fields you change here <span className="whitespace-nowrap">(marked with a <Icon name="Lock" size={12} className="inline align-[-1px]" />)</span> are protected from automatic updates.
                </span>
              </div>
              <button type="button" aria-label="Close" onClick={attemptClose} className="tap grid size-10 shrink-0 place-items-center rounded-full text-fg hover:bg-raised">
                <Icon name="X" size={22} />
              </button>
            </header>

            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-7 pb-6">
              {(update.isError || coverPut.isError) && (
                <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-danger bg-bg px-3 py-2 text-sm text-danger">
                  <Icon name="TriangleAlert" size={16} />
                  {(update.error ?? coverPut.error)!.message}
                </p>
              )}

              {/* The Find button's fixed 36 px slot is reused by the result
                  banner, so none of the form moves when the pane opens. */}
              <div className="pt-4">
                {!findOpen ? (
                  <button type="button" onClick={() => setFindOpen(true)} className={outlinePill}>
                    <Icon name="Globe" size={18} />
                    Find metadata
                  </button>
                ) : suggestion && suggestionCount === 0 ? (
                  <div className="flex h-9 items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3.5 text-success">
                    <Icon name="Check" size={16} className="shrink-0" />
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-bold">Everything matches</span>
                      <span className="text-fg-2">
                        {" "}· {sourceLabel} · {suggestion.title}
                        {suggestionYear && ` (${suggestionYear})`}
                      </span>
                    </span>
                  </div>
                ) : suggestion ? (
                  <div className={clsx("flex h-9 items-center justify-between gap-2 rounded-full border pr-1 pl-3.5", accentTint)}>
                    <span className="min-w-0 truncate text-[13px]">
                      <span className="font-bold">
                        {suggestionCount} suggestion{suggestionCount === 1 ? "" : "s"}
                      </span>
                      <span className="text-fg-2">
                        {" "}from {sourceLabel} · {suggestion.title}
                        {suggestionYear && ` (${suggestionYear})`}
                      </span>
                    </span>
                    <button type="button" onClick={useAll} className={clsx(whitePill, "h-7 shrink-0 px-3 text-sm")}>
                      Use all
                    </button>
                  </div>
                ) : (
                  <div aria-hidden className="h-9" />
                )}
              </div>

              <CoverGroup
                book={book}
                stagedCover={usedCover ?? undefined}
                onDeclineCover={declineCover}
                onCoverPicked={declineCover}
              />

              <Group title="Book">
                <Field name="Title" locked={isLocked("title")} onUnlock={() => unlockField("title")}>
                  <input ref={titleRef} value={form.title} aria-label="Title" onChange={(event) => set("title", event.target.value)} className={inputPill} />
                  {titleError && <span className="text-xs text-danger">{titleError}</span>}
                  {suggestionUi("title")}
                </Field>
                <Field name="Subtitle" locked={isLocked("subtitle")} onUnlock={() => unlockField("subtitle")}>
                  <input value={form.subtitle} aria-label="Subtitle" placeholder="Optional" onChange={(event) => set("subtitle", event.target.value)} className={inputPill} />
                </Field>
                <ChipField
                  label="Authors"
                  noun="author"
                  chips={form.authors}
                  onChange={(authors) => set("authors", authors)}
                  placeholder="Add an author"
                  reorderable
                  hint="Drag to reorder. The first author is shown on covers and lists."
                  locked={isLocked("authors")}
                  onUnlock={() => unlockField("authors")}
                />
                {suggestionUi("authors")}
                <div className="grid grid-cols-2 gap-3.5">
                  <Field name="Series" locked={isLocked("series")} onUnlock={() => unlockField("series")}>
                    <input value={form.series} aria-label="Series" onChange={(event) => set("series", event.target.value)} className={inputPill} />
                    {suggestionUi("series")}
                  </Field>
                  <Field name="Number" locked={isLocked("series_index")} onUnlock={() => unlockField("series_index")}>
                    <div className="w-[120px]">
                      <input value={form.seriesIndex} aria-label="Number" inputMode="decimal" onChange={(event) => set("seriesIndex", event.target.value)} className={inputPill} />
                    </div>
                    {indexError && <span className="text-xs text-danger">{indexError}</span>}
                    {suggestionUi("series_index")}
                  </Field>
                </div>
              </Group>

              <Group title="Publication">
                <div className="grid grid-cols-2 gap-3.5">
                  <Field name="Publisher" locked={isLocked("publisher")} onUnlock={() => unlockField("publisher")}>
                    <input value={form.publisher} aria-label="Publisher" onChange={(event) => set("publisher", event.target.value)} className={inputPill} />
                    {suggestionUi("publisher")}
                  </Field>
                  <Field name="Published" locked={isLocked("published_date")} onUnlock={() => unlockField("published_date")}>
                    <input
                      value={form.publishedDate}
                      aria-label="Published"
                      placeholder="Year or date"
                      onChange={(event) => set("publishedDate", event.target.value)}
                      className={inputPill}
                    />
                    <span className="text-xs text-fg-2">Year, or a full date</span>
                    {suggestionUi("published_date")}
                  </Field>
                  <Field name="Language" locked={isLocked("language")} onUnlock={() => unlockField("language")}>
                    <div className="relative">
                      <select value={form.language} aria-label="Language" onChange={(event) => set("language", event.target.value)} className={selectPill}>
                        {LANGUAGES.map((entry) => (
                          <option key={entry.code} value={entry.code}>
                            {entry.label} ({entry.code})
                          </option>
                        ))}
                        <option value={OTHER}>Other…</option>
                      </select>
                      <Icon name="ChevronDown" size={18} className={selectChevron} />
                    </div>
                    {form.language === OTHER && (
                      <input value={form.otherLanguage} aria-label="Language code" placeholder="e.g. fr-CA" onChange={(event) => set("otherLanguage", event.target.value)} className={inputPill} />
                    )}
                    {languageError && <span className="text-xs text-danger">{languageError}</span>}
                    {suggestionUi("language")}
                  </Field>
                  <Field name="Genre" locked={isLocked("genre")} onUnlock={() => unlockField("genre")}>
                    <div className="relative">
                      <select value={form.genre} aria-label="Genre" onChange={(event) => set("genre", event.target.value)} className={selectPill}>
                        <option value="">No genre</option>
                        {genreOptions.map((genre) => (
                          <option key={genre} value={genre}>
                            {genre}
                          </option>
                        ))}
                        <option value={OTHER}>Other…</option>
                      </select>
                      <Icon name="ChevronDown" size={18} className={selectChevron} />
                    </div>
                    {form.genre === OTHER && (
                      <input
                        value={form.otherGenre}
                        aria-label="New genre"
                        placeholder="e.g. Nautical history"
                        onChange={(event) => set("otherGenre", event.target.value)}
                        className={inputPill}
                      />
                    )}
                    {suggestionUi("genre")}
                  </Field>
                </div>
              </Group>

              <Group title="Identifiers">
                <div className="grid grid-cols-2 gap-3.5">
                  <Field name="ISBN-10" locked={isLocked("isbn10")} onUnlock={() => unlockField("isbn10")}>
                    <input
                      value={form.isbn10}
                      aria-label="ISBN-10"
                      placeholder="Optional"
                      onChange={(event) => set("isbn10", event.target.value)}
                      onBlur={() => setIsbnTouched((current) => ({ ...current, isbn10: true }))}
                      className={inputPill}
                      aria-invalid={isbnTouched.isbn10 && Boolean(isbn10Error)}
                    />
                    {isbnTouched.isbn10 && isbn10Error && <span className="text-xs text-danger">{isbn10Error}</span>}
                    {suggestionUi("isbn10")}
                  </Field>
                  <Field name="ISBN-13" locked={isLocked("isbn13")} onUnlock={() => unlockField("isbn13")}>
                    <input
                      value={form.isbn13}
                      aria-label="ISBN-13"
                      placeholder="Optional"
                      onChange={(event) => set("isbn13", event.target.value)}
                      onBlur={() => setIsbnTouched((current) => ({ ...current, isbn13: true }))}
                      className={inputPill}
                      aria-invalid={isbnTouched.isbn13 && Boolean(isbn13Error)}
                    />
                    {isbnTouched.isbn13 && isbn13Error && <span className="text-xs text-danger">{isbn13Error}</span>}
                    {suggestionUi("isbn13")}
                  </Field>
                </div>
              </Group>

              <Group title="Tags">
                <ChipField
                  label="Tags"
                  noun="tag"
                  chips={form.tags}
                  onChange={(tags) => set("tags", tags)}
                  placeholder="Add a tag"
                  locked={isLocked("tags")}
                  onUnlock={() => unlockField("tags")}
                />
                {suggestionUi("tags")}
              </Group>

              <Group
                title="Description"
                action={
                  isLocked("description") && (
                    <LockButton name="Description" onUnlock={() => unlockField("description")} />
                  )
                }
              >
                <textarea
                  value={form.description}
                  aria-label="Description"
                  rows={7}
                  onChange={(event) => set("description", event.target.value)}
                  className="w-full rounded-[18px] border border-border bg-raised px-[18px] py-3.5 text-md leading-[1.55] resize-y"
                />
                {suggestionUi("description")}
              </Group>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border py-3.5 pr-5 pl-7">
              <span aria-live="polite" className="text-[13px] text-fg-2">
                {changeCount === 0 ? "" : `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}`}
              </span>
              <div className="flex gap-2.5">
                <button type="button" onClick={attemptClose} className={footerPill}>
                  Cancel
                </button>
                <button type="button" onClick={save} disabled={changeCount === 0 || invalid || update.isPending || coverPut.isPending} className={footerPrimary}>
                  Save
                </button>
              </div>
            </footer>
          </div>
        </div>

        {discardOpen && (
          <ConfirmDialog
            title="Discard changes?"
            description="Your unsaved edits in this drawer will be lost."
            confirmLabel="Discard"
            cancelLabel="Keep editing"
            busy={false}
            onCancel={() => setDiscardOpen(false)}
            onConfirm={() => onClose()}
          />
        )}
      </div>
    </div>
  );
}
