/** Library (Direction D §4): grouped shelves (Genre by default) or a flat
 * grid/list, chips with counts, and Group by / Sort / View controls that are
 * remembered per user in localStorage. URL params (from "See all" links)
 * win over the stored preferences. */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import {
  formatLength,
  languageName,
  nativeLanguageName,
  useBookGroups,
  useBooks,
  type BookGroup,
  type BookGroupShelf,
  type BookSort,
} from "../api/books";
import {
  continueQueryKey,
  finishedQueryKey,
  markFinished,
  progressQueryKey,
  resetProgress,
  useProgressMembership,
} from "../api/progress";
import { useUpdateBook } from "../api/metadata";
import { BookCard, BookCover } from "../components/BookCard";
import { BookMenu } from "../components/BookMenu";
import { useCarouselRow } from "../components/Carousel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { NarratorVoiceDialog } from "../components/NarratorVoiceDialog";
import type { Book, Progress } from "../api/types";

const GROUPS: { value: BookGroup; label: string }[] = [
  { value: "none", label: "None" },
  { value: "genre", label: "Genre" },
  { value: "author", label: "Author" },
  { value: "language", label: "Language" },
  { value: "status", label: "Status" },
];

/** "Recently played" rides the API's sort=progress (Progress.updated_at);
 * "Progress" (percent) has no server sort yet — docs/DECISIONS.md. */
type SortValue = BookSort | "played";
const SORTS: { value: SortValue; label: string }[] = [
  { value: "recent", label: "Recently added" },
  { value: "played", label: "Recently played" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "progress", label: "Progress" },
];

type StatusFilter = "all" | "in_progress" | "not_started" | "finished" | "attention";
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in_progress", label: "In progress" },
  { value: "not_started", label: "Not started" },
  { value: "finished", label: "Finished" },
  { value: "attention", label: "Needs attention" },
];

type View = "grid" | "list";
interface Prefs {
  group: BookGroup;
  sort: SortValue;
  view: View;
}
const DEFAULT_PREFS: Prefs = { group: "genre", sort: "recent", view: "grid" };

const GRID =
  "grid gap-x-5 gap-y-7 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]";

function prefsKey(userId: string): string {
  return `folio-library-${userId}`;
}

function loadPrefs(userId: string): Prefs {
  try {
    return {
      ...DEFAULT_PREFS,
      ...(JSON.parse(localStorage.getItem(prefsKey(userId)) ?? "{}") as Partial<Prefs>),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const GROUP_LABELS: Record<string, string> = {
  uploading: "Uploading",
  processing: "Processing",
  ready: "Ready",
  needs_ocr: "Needs OCR",
  failed: "Failed",
};

function groupLabel(group: BookGroup, shelf: BookGroupShelf): string {
  if (group === "language") return languageName(shelf.label);
  if (group === "status") return GROUP_LABELS[shelf.label] ?? shelf.label;
  return shelf.label;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The gradient primary action every empty state points at. */
function UploadLink() {
  return (
    <Link
      to="/upload"
      className="tap mt-2 inline-flex h-12 items-center justify-center rounded-md bg-primary-gradient px-6 font-display font-semibold"
    >
      Upload a book
    </Link>
  );
}

/** Wraps case-insensitive matches of `query` in <mark> on the highlight token. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-xs bg-highlight text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function timeLeft(book: Book, progress: Progress): string {
  if (progress.finished_at) return "Finished";
  if (!book.est_duration_s) return `${Math.round(progress.percent)}% done`;
  return `${formatLength(book.est_duration_s * (1 - progress.percent / 100))} left`;
}

/** Search view: count line, Authors, Books. Reused by SearchPage until the
 * Phase 6 redesign. */
export function SearchResults({
  query,
  books,
  total,
  progressById,
}: {
  query: string;
  books: Book[];
  total: number;
  progressById: Map<string, Progress>;
}) {
  // Authors are grouped from the loaded page: the API returns books, not
  // authors, so counts cover the current result page only (docs/DECISIONS.md).
  const authors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const book of books) {
      for (const author of new Set(book.authors)) {
        if (author.toLowerCase().includes(query.toLowerCase())) {
          counts.set(author, (counts.get(author) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [books, query]);

  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm text-fg-2">
        {total} results for “{query}” in titles, authors and series
      </p>
      {books.length === 0 ? (
        <EmptyState
          icon={<Icon name="search" size={28} />}
          title={`No books match “${query}”`}
          action={<UploadLink />}
        />
      ) : (
        <>
          {authors.length > 0 && (
            <section aria-label="Authors" className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-fg-2">Authors</h2>
              {authors.map(([author, count]) => (
                <Link
                  key={author}
                  to={`/search?q=${encodeURIComponent(author)}`}
                  className="tap flex min-w-0 items-center gap-3 rounded-md bg-raised p-2"
                >
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-selected text-on-selected"
                  >
                    <Icon name="person" size={20} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-base font-semibold">
                      <Highlight text={author} query={query} />
                    </span>
                    <span className="text-xs text-fg-2">
                      {count} {count === 1 ? "book" : "books"}
                    </span>
                  </span>
                </Link>
              ))}
            </section>
          )}
          <section aria-label="Books" className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-fg-2">Books</h2>
            {books.map((book) => {
              const progress = progressById.get(book.id);
              const line = progress
                ? timeLeft(book, progress)
                : book.est_duration_s
                  ? `Not started · ${formatLength(book.est_duration_s)}`
                  : "Not started";
              return (
                <Link
                  key={book.id}
                  to={`/books/${book.id}`}
                  className="tap flex min-w-0 items-center gap-3 rounded-md p-2 hover:bg-raised"
                >
                  <span className="relative block aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-sm shadow-(--shadow-cover)">
                    <BookCover book={book} className="absolute inset-0 h-full w-full" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base font-semibold">
                      <Highlight text={book.title} query={query} />
                    </span>
                    <span className="truncate text-sm text-fg-2">
                      <Highlight text={book.authors.join(", ")} query={query} />
                    </span>
                    <span className="truncate text-xs tabular text-fg-2">{line}</span>
                  </span>
                </Link>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={clsx(
        "tap inline-flex h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-base",
        selected ? "bg-accent font-bold text-on-fg" : "bg-raised font-medium text-fg hover:bg-border",
      )}
    >
      {label}
      {count != null && (
        <>
          {" "}
          <span className={clsx("tabular", selected ? "text-on-fg/75" : "text-fg-2")}>{count}</span>
        </>
      )}
    </button>
  );
}

/** One grouped shelf: title + count, "See all" for genre groups, carousel
 * arrows past five books, and a row of 150px cover cards. */
function Shelf({
  group,
  shelf,
  books,
  progressById,
}: {
  group: BookGroup;
  shelf: BookGroupShelf;
  books: Book[];
  progressById: Map<string, Progress>;
}) {
  const { arrows, row } = useCarouselRow(
    books.map((book) => (
      <div key={book.id} className="w-[150px] shrink-0">
        <BookCard book={book} progress={progressById.get(book.id) ?? null} />
      </div>
    )),
    "gap-[18px]",
  );
  return (
    <section aria-label={groupLabel(group, shelf)} className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-baseline gap-2.5 font-display text-xl">
          <span className="truncate">{groupLabel(group, shelf)}</span>
          <span className="font-ui text-md font-medium tracking-normal text-fg-2 tabular">
            {shelf.count}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {group === "genre" && (
            <Link
              to={`/library?group=none&genre=${encodeURIComponent(shelf.key ?? "none")}`}
              className="text-base font-semibold text-fg-2 no-underline hover:text-fg"
            >
              See all
            </Link>
          )}
          {shelf.count > 5 && arrows}
        </div>
      </div>
      {row}
    </section>
  );
}

/** List-view row: 40px cover, title, author, length, progress, ⋮. */
function ListRow({ book, progress }: { book: Book; progress: Progress | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);
  const [narratorOpen, setNarratorOpen] = useState(false);
  const toggleFinished = useMutation({
    mutationFn: (value: boolean) => markFinished(book.id, value),
    onSuccess: () => invalidate(),
  });
  const reset = useMutation({ mutationFn: () => resetProgress(book.id), onSuccess: () => invalidate() });
  const narratorUpdate = useUpdateBook(book.id);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["books"] });
    void queryClient.invalidateQueries({ queryKey: continueQueryKey });
    void queryClient.invalidateQueries({ queryKey: finishedQueryKey });
  }

  return (
    <li className="flex min-w-0 items-center gap-3.5 rounded-lg px-2 py-1.5 hover:bg-raised/60">
      <Link
        to={`/books/${book.id}`}
        aria-label={book.title}
        className="relative block aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-xs shadow-(--shadow-cover) no-underline"
      >
        <BookCover book={book} className="absolute inset-0 h-full w-full" />
      </Link>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-4">
        <Link
          to={`/books/${book.id}`}
          lang={book.language}
          className="min-w-0 truncate text-md font-semibold text-fg no-underline hover:underline md:flex-1"
        >
          {book.title}
        </Link>
        <span className="min-w-0 truncate text-base text-fg-2 md:w-44">
          {book.authors.join(", ") || "Unknown author"}
        </span>
        <span className="shrink-0 text-base tabular text-fg-2">
          {book.est_duration_s ? formatLength(book.est_duration_s) : ""}
        </span>
        <span className="shrink-0 text-base tabular text-fg-2 md:w-28 md:text-right">
          {progress ? timeLeft(book, progress) : "Not started"}
        </span>
      </span>
      <BookMenu
        finished={Boolean(progress?.finished_at)}
        pending={toggleFinished.isPending}
        onToggleFinished={(value) => toggleFinished.mutate(value)}
        onReset={() => setResetOpen(true)}
        onNarrator={() => setNarratorOpen(true)}
        onGoToAuthor={() =>
          navigate(
            book.authors[0] ? `/search?q=${encodeURIComponent(book.authors[0])}` : "/search",
          )
        }
      />
      {resetOpen && (
        <ConfirmDialog
          title={`Reset your progress in ${book.title}?`}
          description="This cannot be undone."
          confirmLabel="Reset"
          busy={reset.isPending}
          onCancel={() => setResetOpen(false)}
          onConfirm={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                localStorage.removeItem(`folio-pos-${book.id}`);
                void queryClient.invalidateQueries({ queryKey: progressQueryKey(book.id) });
                invalidate();
                setResetOpen(false);
              },
            })
          }
        />
      )}
      {narratorOpen && (
        <NarratorVoiceDialog
          value={book.narrator_voice}
          language={book.language}
          error={narratorUpdate.isError ? narratorUpdate.error.message : null}
          onClose={() => setNarratorOpen(false)}
          onSelect={(next) =>
            narratorUpdate.mutate(
              { narrator_voice: next },
              {
                onSuccess: () => {
                  invalidate();
                  setNarratorOpen(false);
                },
              },
            )
          }
        />
      )}
    </li>
  );
}

export function LibraryPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const stored = useMemo(() => loadPrefs(user?.id ?? "anon"), [user?.id]);

  const group = (params.get("group") as BookGroup | null) ?? stored.group;
  const sort = (params.get("sort") as SortValue | null) ?? stored.sort;
  const view = (params.get("view") as View | null) ?? stored.view;
  const genre = params.get("genre");

  const [status, setStatus] = useState<StatusFilter>("all");
  const [language, setLanguage] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const setPref = (key: "group" | "sort" | "view", value: string) => {
    if (user) {
      localStorage.setItem(
        prefsKey(user.id),
        JSON.stringify({ ...loadPrefs(user.id), [key]: value }),
      );
    }
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set(key, value);
      if (key === "group") next.delete("genre");
      return next;
    });
    setPage(1);
  };

  const apiSort: BookSort = sort === "played" || sort === "progress" ? "progress" : sort;
  const grouped = group !== "none" && view === "grid";
  const listQuery = useBookGroups({ group, sort: apiSort }, { enabled: grouped });
  const flatQuery = useBooks(
    { sort: apiSort, page, genre: genre ?? undefined },
    { enabled: !grouped },
  );
  const data = grouped ? listQuery.data : flatQuery.data;
  const isPending = (grouped ? listQuery.isPending : flatQuery.isPending) && !data;
  const error = grouped ? listQuery.error : flatQuery.error;

  // "Needs attention" count: one grouped-by-status listing, whose group
  // counts cover the whole catalog, not just the loaded page.
  const statusCounts = useBookGroups({ group: "status", sort: "recent" });
  const attention = (statusCounts.data?.groups ?? [])
    .filter((shelf) => shelf.key === "needs_ocr" || shelf.key === "failed")
    .reduce((sum, shelf) => sum + shelf.count, 0);

  const { progressById, inProgress, finished } = useProgressMembership();

  function visible(books: Book[]): Book[] {
    const filtered = books.filter((book) => {
      if (language && book.language !== language) return false;
      if (status === "attention") return book.status === "needs_ocr" || book.status === "failed";
      if (status === "in_progress") return inProgress.has(book.id);
      if (status === "finished") return finished.has(book.id);
      if (status === "not_started") return !inProgress.has(book.id) && !finished.has(book.id);
      return true;
    });
    // ponytail: percent sort covers the loaded page until the API sorts by it.
    return sort === "progress"
      ? [...filtered].sort(
          (a, b) =>
            (progressById.get(b.id)?.percent ?? -1) - (progressById.get(a.id)?.percent ?? -1),
        )
      : filtered;
  }

  const flatBooks = flatQuery.data ? visible(flatQuery.data.items) : [];
  const shelves =
    grouped && listQuery.data
      ? [...listQuery.data.groups]
          .sort(
            (a, b) => Number(a.key === null) - Number(b.key === null) || b.count - a.count,
          )
          .map((shelf) => ({ shelf, books: visible(shelf.books) }))
          .filter(({ books }) => books.length > 0)
      : [];
  const total = grouped
    ? (listQuery.data?.groups ?? []).reduce((sum, shelf) => sum + shelf.count, 0)
    : (flatQuery.data?.total ?? 0);
  const pages = flatQuery.data ? Math.ceil(flatQuery.data.total / flatQuery.data.page_size) : 1;

  const loaded = grouped
    ? (listQuery.data?.groups ?? []).flatMap((shelf) => shelf.books)
    : flatBooks;
  const languages = [...new Set(loaded.map((book) => book.language))].sort();

  const selectClass = "select-pill h-10 border border-border bg-raised text-base text-fg";
  const arrowClass = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">
            {total} {total === 1 ? "book" : "books"}
          </span>
          <h1 className="font-display text-4xl">Library</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-base text-fg-2">
          <label className="flex items-center gap-2">
            Group by
            <span className="relative inline-flex">
              <select
                aria-label="Group by"
                value={group}
                onChange={(event) => setPref("group", event.target.value)}
                className={selectClass}
              >
                {GROUPS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Icon name="ChevronDown" size={18} className={arrowClass} />
            </span>
          </label>
          <label className="flex items-center gap-2">
            Sort
            <span className="relative inline-flex">
              <select
                aria-label="Sort by"
                value={sort}
                onChange={(event) => setPref("sort", event.target.value)}
                className={selectClass}
              >
                {SORTS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Icon name="ChevronDown" size={18} className={arrowClass} />
            </span>
          </label>
          <div role="radiogroup" aria-label="View" className="flex rounded-full bg-raised p-[3px]">
            {(
              [
                { value: "grid", label: "Grid view", icon: "LayoutGrid" },
                { value: "list", label: "List view", icon: "List" },
              ] as { value: View; label: string; icon: IconName }[]
            ).map(({ value, label, icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view === value}
                aria-label={label}
                onClick={() => setPref("view", value)}
                className={clsx(
                  "tap grid h-[34px] w-9 place-items-center rounded-full",
                  view === value ? "bg-fg text-on-fg" : "text-fg hover:bg-border",
                )}
              >
                <Icon name={icon} size={18} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div role="group" aria-label="Filter" className="flex flex-wrap gap-2.5">
        {STATUS_CHIPS.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            count={
              value === "all"
                ? total
                : value === "attention"
                  ? attention
                  : value === "in_progress"
                    ? inProgress.size
                    : value === "finished"
                      ? finished.size
                      : Math.max(0, total - inProgress.size - finished.size)
            }
            selected={status === value && !language}
            onClick={() => {
              setStatus(value);
              setLanguage(null);
            }}
          />
        ))}
        {languages.map((code) => (
          <Chip
            key={code}
            label={nativeLanguageName(code)}
            selected={language === code}
            onClick={() => setLanguage((current) => (current === code ? null : code))}
          />
        ))}
      </div>

      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}

      {isPending && !error && (
        <div className={GRID} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-[2/3] rounded-cover bg-raised" />
              <div className="mt-2 h-4 w-3/4 rounded bg-raised" />
              <div className="mt-1 h-3 w-1/2 rounded bg-raised" />
            </div>
          ))}
        </div>
      )}

      {!isPending && !error && total === 0 && (
        <EmptyState
          icon={<Icon name="LibraryBig" size={28} />}
          title="Your library is empty"
          action={
            <Link
              to="/upload"
              className="tap inline-flex h-10 items-center rounded-full bg-fg px-[18px] text-lg font-bold text-on-fg no-underline"
            >
              Upload books
            </Link>
          }
        />
      )}

      {!isPending && !error && total > 0 && (
        <>
          {grouped ? (
            shelves.length === 0 ? (
              <p className="text-sm text-fg-2">No books match this filter.</p>
            ) : (
              <div className="flex flex-col gap-9">
                {shelves.map(({ shelf, books }) => (
                  <Shelf
                    key={shelf.key ?? ""}
                    group={group}
                    shelf={shelf}
                    books={books}
                    progressById={progressById}
                  />
                ))}
              </div>
            )
          ) : (
            <>
              {view === "list" ? (
                <ul className="flex flex-col gap-1">
                  {flatBooks.map((book) => (
                    <ListRow
                      key={book.id}
                      book={book}
                      progress={progressById.get(book.id) ?? null}
                    />
                  ))}
                </ul>
              ) : (
                <div className={GRID}>
                  {flatBooks.map((book) => (
                    <BookCard key={book.id} book={book} progress={progressById.get(book.id) ?? null} />
                  ))}
                </div>
              )}
              {flatBooks.length === 0 && (
                <p className="text-sm text-fg-2">No books match this filter on page {page}.</p>
              )}
            </>
          )}
        </>
      )}

      {!grouped && flatQuery.data && pages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="tap rounded-full px-4 text-base font-medium text-fg-2 hover:bg-raised disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-base tabular text-fg-2">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="tap rounded-full px-4 text-base font-medium text-fg-2 hover:bg-raised disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
