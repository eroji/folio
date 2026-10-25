import { useState } from "react";
import { useApplyMetadata, useMetadataSearch } from "../api/metadata";
import { Icon } from "./Icon";
import type { Book, Candidate } from "../api/types";

/** Candidate fields offered as apply checkboxes. `cover_url` is deliberately
 * absent: applying a provider cover goes through the cover editor's URL fetch. */
const FIELDS: { key: keyof Candidate; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "authors", label: "Authors" },
  { key: "series", label: "Series" },
  { key: "series_index", label: "Series number" },
  { key: "published_date", label: "Published" },
  { key: "publisher", label: "Publisher" },
  { key: "description", label: "Description" },
  { key: "language", label: "Language" },
  { key: "isbn10", label: "ISBN-10" },
  { key: "isbn13", label: "ISBN-13" },
  { key: "tags", label: "Tags" },
];

function hasValue(value: unknown): boolean {
  return value != null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

const SOURCES: Record<string, string> = { openlibrary: "Open Library", googlebooks: "Google Books" };

const inputClass = "tap h-9 w-full rounded-md border border-control-border bg-surface px-3 text-base";

function CandidateCard({ book, candidate }: { book: Book; candidate: Candidate }) {
  const available = FIELDS.filter((field) => hasValue(candidate[field.key]));
  const [selected, setSelected] = useState<string[]>(available.map((field) => field.key));
  const [applied, setApplied] = useState<string[] | null>(null);
  const apply = useApplyMetadata(book.id);

  return (
    <li className="flex gap-3 rounded-lg border border-divider bg-surface p-4">
      {candidate.cover_url ? (
        <img src={candidate.cover_url} alt="" loading="lazy" className="aspect-[2/3] w-12 shrink-0 rounded-cover bg-raised object-cover" />
      ) : (
        <div className="aspect-[2/3] w-12 shrink-0 rounded-cover bg-cover-placeholder" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-medium">{candidate.title}</p>
          <p className="truncate text-xs text-fg-2">
            {[
              candidate.authors.join(", "),
              candidate.published_date?.slice(0, 4),
              SOURCES[candidate.source] ?? candidate.source,
              `${Math.round(candidate.score * 100)}% match`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">Fields to apply from “{candidate.title}”</legend>
          {available.map((field) => (
            <label key={field.key} className="tap flex min-h-8 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(field.key)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key),
                  )
                }
                className="size-4 accent-progress"
              />
              {field.label}
            </label>
          ))}
        </fieldset>
        <div>
          <button
            type="button"
            disabled={selected.length === 0 || apply.isPending}
            onClick={() =>
              apply.mutate(
                { payload: candidate, fields: selected },
                { onSuccess: (data) => setApplied(data.applied) },
              )
            }
            className="tap inline-flex h-9 items-center rounded-md bg-primary-gradient px-4 text-base font-semibold text-on-primary disabled:opacity-50"
          >
            Apply selected
          </button>
        </div>
        {applied && (
          <p role="status" className="text-xs text-fg-2">
            Applied: {applied.join(", ")}
          </p>
        )}
        {apply.error && (
          <p role="alert" className="text-sm text-danger">
            {apply.error.message}
          </p>
        )}
      </div>
    </li>
  );
}

/** "Find metadata" panel (spec Screens 4-5). `initialItems` preloads saved
 * candidates for the "Review metadata matches" flow. */
export function FindMetadata({ book, initialItems }: { book: Book; initialItems?: Candidate[] }) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.authors[0] ?? "");
  const [isbn, setIsbn] = useState(book.isbn13 ?? book.isbn10 ?? "");
  const [items, setItems] = useState<Candidate[] | null>(initialItems ?? null);
  const search = useMetadataSearch(book.id);

  return (
    <section aria-label="Find metadata" className="flex flex-col gap-4 rounded-lg border border-divider bg-surface p-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-base font-medium">
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-base font-medium">
          Author
          <input value={author} onChange={(event) => setAuthor(event.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-base font-medium">
          ISBN
          <input value={isbn} onChange={(event) => setIsbn(event.target.value)} className={inputClass} />
        </label>
      </div>
      <div>
        <button
          type="button"
          disabled={search.isPending || (!title.trim() && !isbn.trim())}
          onClick={() =>
            search.mutate(
              {
                q: [title.trim(), author.trim()].filter(Boolean).join(" "),
                isbn: isbn.trim() || undefined,
              },
              { onSuccess: (data) => setItems(data.items) },
            )
          }
          className="tap inline-flex h-9 items-center gap-1.5 rounded-md border border-control-border bg-surface px-3 text-base font-medium hover:bg-raised disabled:opacity-50"
        >
          <Icon name="search" size={18} />
          Search
        </button>
      </div>

      {search.error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger">
          <Icon name="error" size={16} />
          The metadata providers could not be reached. {search.error.message}
        </p>
      )}

      {items && items.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-fg-2">
          <Icon name="search" size={16} />
          No matches found. Try a different title or ISBN.
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((candidate, index) => (
            <CandidateCard key={`${candidate.source}-${index}`} book={book} candidate={candidate} />
          ))}
        </ul>
      )}
    </section>
  );
}
