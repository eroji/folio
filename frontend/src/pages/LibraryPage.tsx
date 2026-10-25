import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useBooks, type BookSort } from "../api/books";
import {
  useContinueListening,
  useFinishedListening,
  type ContinueItem,
} from "../api/progress";
import { BookCard, BookCover, coverName } from "../components/BookCard";
import { CoverProgressBadge } from "../components/CoverProgressBadge";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { Book, Progress } from "../api/types";

const SORTS: { value: BookSort; label: string }[] = [
  { value: "recent", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
  { value: "progress", label: "Progress" },
];

type Filter = "all" | "in_progress" | "not_started" | "finished";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in_progress", label: "In progress" },
  { value: "not_started", label: "Not started" },
  { value: "finished", label: "Finished" },
];

const GRID =
  "grid gap-x-4 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(128px,1fr))]";

/** "2 h 36 m" / "8 m" — the handoff's time-left shape. */
function formatLeft(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} m`
    : `${minutes} m`;
}

function timeLeft(book: Book, progress: Progress): string {
  if (progress.finished_at) return "Finished";
  if (!book.est_duration_s) return `${Math.round(progress.percent)}% done`;
  return `${formatLeft(book.est_duration_s * (1 - progress.percent / 100))} left`;
}

/** Continue-card line: "2 h 36 m left". The reference adds "Ch. 3 ·", but
 * /me/continue exposes no chapter number (docs/DECISIONS.md). */
function continueLine(book: Book, progress: Progress): string {
  if (progress.finished_at) return "Finished";
  if (!book.est_duration_s) return `${Math.round(progress.percent)}% listened`;
  return `${formatLeft(book.est_duration_s * (1 - progress.percent / 100))} left`;
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

/** Up to four resume cards; hidden while /me/continue is empty. */
function ContinueRow({ items }: { items: ContinueItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Continue listening" className="flex flex-col gap-2.5">
      <h2 className="text-md font-semibold">Continue listening</h2>
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
        {items.slice(0, 4).map(({ book, progress }) => (
          <li key={book.id} className="min-w-0">
            <Link
              to={`/player?book=${book.id}&chapter=${progress.chapter_id}`}
              aria-label={[book.title, coverName(book, progress), "resume"].filter(Boolean).join(", ")}
              className="tap flex min-w-0 items-center gap-3 rounded-lg border border-divider bg-surface p-2"
            >
              <span className="relative block aspect-[2/3] w-14 shrink-0 overflow-hidden rounded-cover shadow-(--shadow-cover)">
                <BookCover
                  book={book}
                  className="absolute inset-0 h-full w-full"
                />
                <CoverProgressBadge
                  percent={
                    progress.finished_at || progress.percent <= 0
                      ? null
                      : progress.percent
                  }
                  finished={Boolean(progress.finished_at)}
                />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-base font-semibold">
                  {book.title}
                </span>
                <span className="truncate text-xs tabular text-fg-2">
                  {continueLine(book, progress)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Search view (handoff "Search"): count line, Authors, Books. */
function SearchResults({
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
                  to={`/?q=${encodeURIComponent(author)}`}
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
                  ? `Not started · ${formatLeft(book.est_duration_s)}`
                  : "Not started";
              return (
                <Link
                  key={book.id}
                  to={`/books/${book.id}`}
                  className="tap flex min-w-0 items-center gap-3 rounded-md p-2 hover:bg-raised"
                >
                  <span className="relative block aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-sm shadow-(--shadow-cover)">
                    <BookCover
                      book={book}
                      className="absolute inset-0 h-full w-full"
                    />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base font-semibold">
                      <Highlight text={book.title} query={query} />
                    </span>
                    <span className="truncate text-sm text-fg-2">
                      <Highlight text={book.authors.join(", ")} query={query} />
                    </span>
                    <span className="truncate text-xs tabular text-fg-2">
                      {line}
                    </span>
                  </span>
                </Link>
              );
            })}
          </section>
        </>
      )}
      <p className="text-xs text-fg-2">
        Press / anywhere to search · Esc to clear
      </p>
    </div>
  );
}

export function LibraryPage() {
  const location = useLocation();
  const urlQuery = useMemo(
    () => new URLSearchParams(location.search).get("q") ?? "",
    [location.search],
  );
  const [search, setSearch] = useState(urlQuery);
  const [query, setQuery] = useState(urlQuery.trim());
  const [sort, setSort] = useState<BookSort>("recent");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);

  // The shell's Search entry and the "/" shortcut land on /?focus=search.
  // location.key changes on every navigation, so pressing "/" twice refocuses.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("focus") === "search")
      searchRef.current?.focus();
  }, [location.key, location.search]);

  // Author/tag links arrive as ?q=…; adopt it without clobbering a search the
  // user is typing when the URL carries no query.
  useEffect(() => {
    if (!urlQuery) return;
    setSearch(urlQuery);
    setQuery(urlQuery.trim());
  }, [location.key, urlQuery]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, sort, filter]);

  const { data, isPending, error } = useBooks({
    q: query || undefined,
    sort,
    page,
  });
  const { data: continueData } = useContinueListening(50);
  const { data: finishedData } = useFinishedListening(50);
  const books = data?.items ?? [];
  const pages = data ? Math.ceil(data.total / data.page_size) : 1;
  const searching = query.length > 0;

  // Progress membership for the chips and the badges. The API exposes no
  // per-book progress on /books, so in-progress/finished come from
  // /me/continue and /me/finished (capped at 50 each, docs/DECISIONS.md).
  const { progressById, inProgress, finished } = useMemo(() => {
    const progressById = new Map<string, Progress>();
    const inProgress = new Set<string>();
    const finished = new Set<string>();
    for (const item of continueData?.items ?? []) {
      progressById.set(item.book.id, item.progress);
      if (item.progress.finished_at) finished.add(item.book.id);
      else inProgress.add(item.book.id);
    }
    for (const item of finishedData?.items ?? []) {
      progressById.set(item.book.id, item.progress);
      finished.add(item.book.id);
    }
    return { progressById, inProgress, finished };
  }, [continueData, finishedData]);

  const counts: Record<Filter, number> = {
    all: data?.total ?? 0,
    in_progress: inProgress.size,
    not_started: Math.max(
      0,
      (data?.total ?? 0) - inProgress.size - finished.size,
    ),
    finished: finished.size,
  };
  const visible = books.filter((book) =>
    filter === "all"
      ? true
      : filter === "in_progress"
        ? inProgress.has(book.id)
        : filter === "finished"
          ? finished.has(book.id)
          : !inProgress.has(book.id) && !finished.has(book.id),
  );

  const clearSearch = () => {
    setSearch("");
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 desktop:flex-row desktop:items-center">
        <h1 className="font-display text-xl font-bold tracking-[-0.01em]">
          Library
        </h1>
        <div className="relative min-w-0 flex-1">
          <Icon
            name="search"
            size={20}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-2"
          />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search books"
            placeholder="Search titles, authors, series"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                clearSearch();
                searchRef.current?.focus();
              }
            }}
            className={clsx(
              "tap h-9 w-full rounded-md border bg-surface pr-9 pl-[38px] text-base text-fg outline-none placeholder:text-fg-2",
              searching ? "border-2 border-progress" : "border-control-border",
            )}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                clearSearch();
                searchRef.current?.focus();
              }}
              className="absolute top-1/2 right-0.5 grid size-8 -translate-y-1/2 place-items-center rounded-md text-fg-2 hover:bg-raised"
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
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

      {!isPending && !error && searching && (
        <SearchResults
          query={query}
          books={books}
          total={data?.total ?? 0}
          progressById={progressById}
        />
      )}

      {!isPending && !error && !searching && (
        <>
          <ContinueRow items={continueData?.items ?? []} />
          <section aria-label="All books" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="group"
                aria-label="Filter books"
                className="flex flex-wrap gap-1.5"
              >
                {FILTERS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={clsx(
                      "tap inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm",
                      filter === value
                        ? "bg-selected font-semibold text-on-selected"
                        : "border border-control-border bg-transparent font-medium text-fg hover:bg-raised",
                    )}
                  >
                    {label}{" "}
                    <span
                      className={clsx(
                        "text-xs tabular",
                        filter === value ? "text-on-selected" : "text-fg-2",
                      )}
                    >
                      {counts[value]}
                    </span>
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-sm text-fg-2">
                Sort
                <select
                  aria-label="Sort by"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as BookSort)}
                  className="h-9 rounded-md border border-control-border bg-surface px-2 text-base text-fg"
                >
                  {SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {books.length === 0 ? (
              <EmptyState
                icon={<Icon name="auto_stories" size={28} />}
                title="No books yet"
                description="Upload your first EPUB, PDF or Kindle file."
                action={<UploadLink />}
              />
            ) : visible.length === 0 ? (
              <p className="text-sm text-fg-2">
                No books match this filter on page {page}.
              </p>
            ) : (
              <div className={GRID}>
                {visible.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    progress={progressById.get(book.id) ?? null}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {data && pages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="tap rounded-md px-4 text-sm font-medium text-fg-2 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm tabular text-fg-2">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="tap rounded-md px-4 text-sm font-medium text-fg-2 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
