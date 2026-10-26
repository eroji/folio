import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useBook } from "../api/books";
import { useUpdateBook, type BookPatch } from "../api/metadata";
import { CoverEditor } from "../components/CoverEditor";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { Book } from "../api/types";

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
  "Literary fiction",
  "Science fiction",
  "Fantasy",
  "Mystery & thriller",
  "Gothic & horror",
  "Romance",
  "Historical fiction",
  "Myth & epic",
  "Poetry",
  "Drama",
  "Biography & memoir",
  "History",
  "Science",
  "Philosophy",
  "Nonfiction",
  "Children's",
  "Japanese literature",
  "Korean literature",
  "Chinese literature",
];

const inputClass = "tap h-10 w-full rounded-full border border-border bg-raised px-4 text-md";
const buttonClass =
  "tap inline-flex h-10 items-center gap-2 rounded-full border border-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised disabled:opacity-50";
const primaryButtonClass =
  "tap inline-flex h-10 items-center rounded-full bg-fg px-4 text-base font-bold text-on-fg disabled:opacity-50";
const selectPill = "select-pill tap h-10 w-full border border-border bg-raised text-base text-fg";
const selectChevron = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";

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
  narratorVoice: string;
}

function fromBook(book: Book): Form {
  const known = LANGUAGES.some((entry) => entry.code === book.language);
  const genreValue = book.genre ? (GENRES.includes(book.genre) ? book.genre : OTHER) : "";
  return {
    title: book.title,
    subtitle: book.subtitle ?? "",
    authors: [...book.authors],
    series: book.series ?? "",
    seriesIndex: book.series_index == null ? "" : String(book.series_index),
    description: book.description ?? "",
    publisher: book.publisher ?? "",
    publishedDate: book.published_date ?? "",
    language: known ? book.language : OTHER,
    otherLanguage: known ? "" : book.language,
    isbn10: book.isbn10 ?? "",
    isbn13: book.isbn13 ?? "",
    tags: [...book.tags],
    genre: genreValue,
    otherGenre: genreValue === OTHER ? (book.genre ?? "") : "",
    narratorVoice: book.narrator_voice ?? "",
  };
}

const trimmed = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** Only the fields the user actually changed; empty strings clear nullable fields. */
export function buildPatch(form: Form, book: Book): BookPatch {
  const patch: BookPatch = {};
  const text = <K extends "subtitle" | "series" | "description" | "publisher" | "published_date" | "isbn10" | "isbn13" | "narrator_voice">(
    key: K,
    value: string | null,
  ) => {
    if ((value ?? "") !== (book[key] ?? "")) patch[key] = value;
  };
  text("subtitle", trimmed(form.subtitle));
  text("series", trimmed(form.series));
  text("description", trimmed(form.description));
  text("publisher", trimmed(form.publisher));
  text("published_date", trimmed(form.publishedDate));
  text("isbn10", trimmed(form.isbn10));
  text("isbn13", trimmed(form.isbn13));
  text("narrator_voice", trimmed(form.narratorVoice));
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-base font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Ordered list editor: editable rows with up/down/remove plus an add input. */
function OrderedList({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...items, draft.trim()]);
    setDraft("");
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    onChange(next);
  };
  const iconButton = "tap grid size-10 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised disabled:opacity-40";
  return (
    <div className="flex flex-col gap-2">
      <span className="text-base font-medium">{label}</span>
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li key={index} className="flex items-center gap-1">
            <input
              value={item}
              aria-label={`${label} ${index + 1}`}
              onChange={(event) => onChange(items.map((current, i) => (i === index ? event.target.value : current)))}
              className={inputClass}
            />
            <button type="button" aria-label={`Move ${label.toLowerCase()} ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className={iconButton}>
              <Icon name="ChevronLeft" size={18} className="-rotate-90" />
            </button>
            <button type="button" aria-label={`Move ${label.toLowerCase()} ${index + 1} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)} className={iconButton}>
              <Icon name="ChevronLeft" size={18} className="rotate-90" />
            </button>
            <button type="button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))} className={iconButton}>
              <Icon name="X" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          value={draft}
          aria-label={`Add ${label.toLowerCase()}`}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className={inputClass}
        />
        <button type="button" onClick={add} className={buttonClass}>
          Add
        </button>
      </div>
    </div>
  );
}

function EditForm({ book }: { book: Book }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => fromBook(book));
  const update = useUpdateBook(book.id);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  const patch = buildPatch(form, book);
  const isbnError =
    (form.isbn10.trim() !== "" && !isbn10Valid(form.isbn10) && "This ISBN-10 checksum is not valid.") ||
    (form.isbn13.trim() !== "" && !isbn13Valid(form.isbn13) && "This ISBN-13 checksum is not valid.") ||
    null;
  const indexError = form.seriesIndex.trim() !== "" && Number.isNaN(Number(form.seriesIndex)) ? "Series number must be a number." : null;
  const languageError = form.language === OTHER && form.otherLanguage.trim() === "" ? "Enter a language code." : null;
  const titleError = form.title.trim() === "" ? "Title is required." : null;
  const invalid = Boolean(isbnError ?? indexError ?? languageError ?? titleError);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        update.mutate(patch, { onSuccess: () => navigate(`/books/${book.id}`) });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-xl">Edit metadata</h1>
        <div className="flex gap-2">
          <Link to={`/books/${book.id}`} className={buttonClass}>
            Cancel
          </Link>
          <button
            type="submit"
            disabled={invalid || Object.keys(patch).length === 0 || update.isPending}
            className={primaryButtonClass}
          >
            Save
          </button>
        </div>
      </div>

      {update.error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger">
          <Icon name="TriangleAlert" size={16} />
          {update.error.message}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Title">
          <input value={form.title} onChange={(event) => set("title", event.target.value)} className={inputClass} />
          {titleError && <span className="text-xs text-danger">{titleError}</span>}
        </Field>
        <Field label="Subtitle">
          <input value={form.subtitle} onChange={(event) => set("subtitle", event.target.value)} className={inputClass} />
        </Field>
      </div>

      <OrderedList label="Authors" items={form.authors} onChange={(authors) => set("authors", authors)} placeholder="Add an author" />

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Series">
          <input value={form.series} onChange={(event) => set("series", event.target.value)} className={inputClass} />
        </Field>
        <Field label="Series number">
          <input value={form.seriesIndex} inputMode="decimal" onChange={(event) => set("seriesIndex", event.target.value)} className={inputClass} />
          {indexError && <span className="text-xs text-danger">{indexError}</span>}
        </Field>
        <Field label="Publisher">
          <input value={form.publisher} onChange={(event) => set("publisher", event.target.value)} className={inputClass} />
        </Field>
        <Field label="Published date">
          <input value={form.publishedDate} placeholder="YYYY or YYYY-MM-DD" onChange={(event) => set("publishedDate", event.target.value)} className={inputClass} />
        </Field>
        <Field label="Language">
          <div className="relative">
            <select value={form.language} onChange={(event) => set("language", event.target.value)} className={selectPill}>
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
            <input value={form.otherLanguage} aria-label="Language code" placeholder="e.g. fr-CA" onChange={(event) => set("otherLanguage", event.target.value)} className={inputClass} />
          )}
          {languageError && <span className="text-xs text-danger">{languageError}</span>}
        </Field>
        <Field label="Genre">
          <div className="relative">
            <select value={form.genre} onChange={(event) => set("genre", event.target.value)} className={selectPill}>
              <option value="">No genre</option>
              {GENRES.map((genre) => (
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
              className={inputClass}
            />
          )}
        </Field>
        <Field label="Narrator voice override">
          <input value={form.narratorVoice} placeholder="e.g. ashley-en" onChange={(event) => set("narratorVoice", event.target.value)} className={inputClass} />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="ISBN-10">
          <input value={form.isbn10} onChange={(event) => set("isbn10", event.target.value)} className={inputClass} />
        </Field>
        <Field label="ISBN-13">
          <input value={form.isbn13} onChange={(event) => set("isbn13", event.target.value)} className={inputClass} />
        </Field>
      </div>
      {isbnError && <p className="text-xs text-danger">{isbnError}</p>}

      <OrderedList label="Tags" items={form.tags} onChange={(tags) => set("tags", tags)} placeholder="Add a tag" />

      <Field label="Description">
        <textarea value={form.description} rows={6} onChange={(event) => set("description", event.target.value)} className="tap w-full rounded-lg border border-border bg-raised px-4 py-2 text-md" />
      </Field>

      <CoverEditor book={book} className="rounded-lg border border-border bg-surface p-4" />
    </form>
  );
}

/** Screen 5. Optimistic PATCH of only the changed fields; the server response is authoritative. */
export function EditBookPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { data, isPending, error } = useBook(id);

  if (error) {
    return (
      <EmptyState
        icon={<Icon name="TriangleAlert" size={24} />}
        title="Book not found"
        description={error.message}
        action={
          <Link to="/library" className="text-base font-semibold text-fg underline">
            Back to library
          </Link>
        }
      />
    );
  }
  if (isPending || !data) {
    return (
      <div className="animate-pulse space-y-4" aria-busy="true">
        <div className="h-9 w-1/2 rounded-md bg-raised" />
        <div className="h-64 rounded-lg bg-raised" />
      </div>
    );
  }
  return <EditForm key={id} book={data.book} />;
}
