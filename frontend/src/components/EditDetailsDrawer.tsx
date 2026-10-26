/** Edit details drawer (handoff "Edit details drawer"): a right-side drawer
 * over the book page replacing the old full-page Edit metadata view. Fixed
 * header/footer, groups (Cover, Book, Publication, Identifiers, Tags,
 * Description) in a scrollbar-less body, per-field locks backed by
 * POST /books/{id}/unlock, and an in-drawer 2:3 cover crop. Focus moves to
 * Title and is trapped; Esc / scrim / X close with an unsaved-changes check. */
import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { useDeleteCover, useSetCoverUrl, useUnlockField, useUpdateBook, useUploadCover, type BookPatch } from "../api/metadata";
import { ConfirmDialog } from "./ConfirmDialog";
import { FindMetadata } from "./FindMetadata";
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

/** 13px/600 label with a fixed 24px row so side-by-side fields line up;
 * an accent lock button appears while the field is protected. */
function FieldLabel({ name, locked, onUnlock }: { name: string; locked: boolean; onUnlock: () => void }) {
  return (
    <span className="flex min-h-6 items-center gap-1 text-[13px] font-semibold">
      {name}
      {locked && (
        <button
          type="button"
          onClick={onUnlock}
          title="Protected from automatic updates · click to unlock"
          aria-label={`${name} is protected from automatic updates. Unlock`}
          className="grid size-6 place-items-center rounded-full text-accent hover:bg-raised"
        >
          <Icon name="Lock" size={14} />
        </button>
      )}
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3.5 border-t border-border py-5 first:border-t-0">
      <h3 className="eyebrow">{title}</h3>
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

function CoverGroup({ book }: { book: Book }) {
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
      <Group title="Cover">
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
    <Group title="Cover">
      <div className="flex flex-wrap items-center gap-5">
        {book.cover_url ? (
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
          <button
            type="button"
            disabled={!book.cover_url || removeCover.isPending}
            onClick={() => removeCover.mutate()}
            className="tap self-start py-1 text-base font-semibold text-fg-2 underline hover:text-fg disabled:opacity-50"
          >
            Remove cover
          </button>
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
  /** "Review metadata matches" opens straight into the find view. */
  initialReviewItems?: Candidate[];
}) {
  const [form, setForm] = useState<Form>(() => fromBook(book));
  const [isbnTouched, setIsbnTouched] = useState({ isbn10: false, isbn13: false });
  const [unlocked, setUnlocked] = useState<string[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(Boolean(initialReviewItems?.length));
  const bookRef = useRef(book);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const update = useUpdateBook(book.id);
  const unlock = useUnlockField(book.id);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Applying provider metadata replaces the book in the query cache. Refresh
  // the form from it — safe because Find is disabled while edits are unsaved.
  useEffect(() => {
    if (findOpen && bookRef.current !== book) setForm(fromBook(book));
    bookRef.current = book;
  }, [book, findOpen]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const patch = buildPatch(form, book);
  const changeCount = Object.keys(patch).length;

  const locked = new Set((book.locked_fields ?? []).filter((field) => !unlocked.includes(field)));
  const isLocked = (field: (typeof LOCKABLE_FIELDS)[number]) => locked.has(field);
  function unlockField(field: (typeof LOCKABLE_FIELDS)[number]) {
    unlock.mutate(field, { onSuccess: () => setUnlocked((current) => [...current, field]) });
  }

  const titleError = form.title.trim() === "" ? "Title is required." : null;
  const isbn10Error = form.isbn10.trim() !== "" && !isbn10Valid(form.isbn10) ? "This ISBN-10 checksum is not valid." : null;
  const isbn13Error = form.isbn13.trim() !== "" && !isbn13Valid(form.isbn13) ? "This ISBN-13 checksum is not valid." : null;
  const indexError = form.seriesIndex.trim() !== "" && Number.isNaN(Number(form.seriesIndex)) ? "Series number must be a number." : null;
  const languageError = form.language === OTHER && form.otherLanguage.trim() === "" ? "Enter a language code." : null;
  const isbnInvalid =
    (isbnTouched.isbn10 && isbn10Error) || (isbnTouched.isbn13 && isbn13Error);
  const invalid = Boolean(titleError ?? isbnInvalid ?? indexError ?? languageError);

  function attemptClose() {
    if (changeCount > 0) setDiscardOpen(true);
    else onClose();
  }

  function save() {
    if (invalid || changeCount === 0) return;
    update.mutate(patch, { onSuccess: onClose });
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      if (discardOpen) return; // the confirm dialog handles its own dismissal
      event.stopPropagation();
      if (findOpen) {
        setFindOpen(false);
        return;
      }
      attemptClose();
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
        className="drawer-in flex h-full w-full max-w-[600px] flex-col border-l border-border bg-surface shadow-[-24px_0_60px_rgb(0_0_0/0.5)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 pt-[18px] pr-5 pb-3.5 pl-7">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="edit-details-title" className="font-display text-xl">
              {findOpen ? "Find metadata" : "Edit details"}
            </h2>
            <span className="text-[13px] text-fg-2">
              {findOpen ? (
                "Search Open Library and Google Books, then apply the fields you want."
              ) : (
                <>
                  Fields you change here <span className="whitespace-nowrap">(marked with a <Icon name="Lock" size={12} className="inline align-[-1px]" />)</span> are protected from automatic updates.
                </>
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {findOpen && (
              <button
                type="button"
                aria-label="Back to details"
                onClick={() => setFindOpen(false)}
                className={outlinePill}
              >
                <Icon name="ArrowLeft" size={18} />
                Back
              </button>
            )}
            <button type="button" aria-label="Close" onClick={attemptClose} className="tap grid size-10 shrink-0 place-items-center rounded-full text-fg hover:bg-raised">
              <Icon name="X" size={22} />
            </button>
          </div>
        </header>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-7 pb-6">
          {findOpen ? (
            <FindMetadata book={book} initialItems={initialReviewItems} />
          ) : (
            <>
          {update.isError && (
            <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-danger bg-bg px-3 py-2 text-sm text-danger">
              <Icon name="TriangleAlert" size={16} />
              {update.error.message}
            </p>
          )}

          {!findOpen && (
            <div className="pt-4">
              <button
                type="button"
                onClick={() => setFindOpen(true)}
                disabled={changeCount > 0}
                title={changeCount > 0 ? "Save or discard your changes first" : undefined}
                className={outlinePill}
              >
                <Icon name="Globe" size={18} />
                Find metadata
              </button>
            </div>
          )}

          <CoverGroup book={book} />

          <Group title="Book">
            <Field name="Title" locked={isLocked("title")} onUnlock={() => unlockField("title")}>
              <input ref={titleRef} value={form.title} aria-label="Title" onChange={(event) => set("title", event.target.value)} className={inputPill} />
              {titleError && <span className="text-xs text-danger">{titleError}</span>}
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
            <div className="grid grid-cols-2 gap-3.5">
              <Field name="Series" locked={isLocked("series")} onUnlock={() => unlockField("series")}>
                <input value={form.series} aria-label="Series" onChange={(event) => set("series", event.target.value)} className={inputPill} />
              </Field>
              <Field name="Number" locked={isLocked("series_index")} onUnlock={() => unlockField("series_index")}>
                <div className="w-[120px]">
                  <input value={form.seriesIndex} aria-label="Number" inputMode="decimal" onChange={(event) => set("seriesIndex", event.target.value)} className={inputPill} />
                </div>
                {indexError && <span className="text-xs text-danger">{indexError}</span>}
              </Field>
            </div>
          </Group>

          <Group title="Publication">
            <div className="grid grid-cols-2 gap-3.5">
              <Field name="Publisher" locked={isLocked("publisher")} onUnlock={() => unlockField("publisher")}>
                <input value={form.publisher} aria-label="Publisher" onChange={(event) => set("publisher", event.target.value)} className={inputPill} />
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
          </Group>

          <Group title="Description">
            <Field name="Description" locked={isLocked("description")} onUnlock={() => unlockField("description")}>
              <textarea
                value={form.description}
                aria-label="Description"
                rows={7}
                onChange={(event) => set("description", event.target.value)}
                className="w-full rounded-[18px] border border-border bg-raised px-[18px] py-3.5 text-md leading-[1.55] resize-y"
              />
            </Field>
          </Group>
            </>
          )}
        </div>

        {!findOpen && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border py-3.5 pr-5 pl-7">
          <span aria-live="polite" className="text-[13px] text-fg-2">
            {changeCount === 0 ? "" : `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}`}
          </span>
          <div className="flex gap-2.5">
            <button type="button" onClick={attemptClose} className={footerPill}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={changeCount === 0 || invalid || update.isPending} className={footerPrimary}>
              Save
            </button>
          </div>
        </footer>
        )}

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
