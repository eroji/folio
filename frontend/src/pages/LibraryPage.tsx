import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Library } from "lucide-react";
import { useBooks, type BookSort } from "../api/books";
import { useContinueListening } from "../api/progress";
import { BookCard, BookCover } from "../components/BookCard";
import { EmptyState } from "../components/EmptyState";
import type { Book, BookStatus, Progress } from "../api/types";

const SORTS: { value: BookSort; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "title", label: "Title" },
  { value: "author", label: "Author" },
];

const STATUSES: { value: BookStatus; label: string }[] = [
  { value: "uploading", label: "Uploading" },
  { value: "processing", label: "Processing" },
  { value: "ready", label: "Ready" },
  { value: "needs_ocr", label: "Needs OCR" },
  { value: "failed", label: "Failed" },
];

const GRID = "grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6";

function timeLeft(book: Book, progress: Progress): string {
  if (progress.finished_at) return "Finished";
  if (!book.est_duration_s) return `${Math.round(progress.percent)}% done`;
  const minutes = Math.max(1, Math.round((book.est_duration_s * (1 - progress.percent / 100)) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
}

/** Screen 2 (home): "Continue listening" row above the catalog grid. */
function ContinueRow() {
  const { data } = useContinueListening(10);
  const items = data?.items ?? [];
  if (items.length === 0) return null; // hidden while /me/continue is empty
  return (
    <section aria-label="Continue listening" className="flex flex-col gap-2">
      <h2 className="font-display text-lg font-semibold">Continue listening</h2>
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {items.map(({ book, progress }) => (
          <li key={book.id} className="w-40 shrink-0">
            <Link to={`/books/${book.id}`} className="flex flex-col gap-1.5">
              <BookCover book={book} className="aspect-[2/3] w-full rounded-card" />
              <span className="truncate text-sm font-medium">{book.title}</span>
              <span aria-hidden className="h-1 w-full overflow-hidden rounded-pill bg-line">
                <span className="block h-full rounded-pill bg-brand-gradient" style={{ width: `${Math.min(100, progress.percent)}%` }} />
              </span>
              <span className="text-xs tabular-nums text-muted">{timeLeft(book, progress)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
export function LibraryPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BookSort>("recent");
  const [status, setStatus] = useState<BookStatus | "">("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [query, sort, status]);

  const { data, isPending, error } = useBooks({
    q: query || undefined,
    sort,
    status: status || undefined,
    page,
  });
  const books = data?.items ?? [];
  const pages = data ? Math.ceil(data.total / data.page_size) : 1;

  return (
    <div className="flex flex-col gap-4">
      <ContinueRow />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search books"
          placeholder="Search title, author, series"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-11 min-w-0 flex-1 rounded-pill border border-line bg-card px-4 text-sm outline-none placeholder:text-muted"
        />
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(event) => setSort(event.target.value as BookSort)}
          className="h-11 rounded-pill border border-line bg-card px-3 text-sm"
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as BookStatus | "")}
          className="h-11 rounded-pill border border-line bg-card px-3 text-sm"
        >
          <option value="">All statuses</option>
          {STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {error instanceof Error && <p role="alert" className="text-sm text-danger">{error.message}</p>}

      {isPending && !error && (
        <div className={GRID} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-[2/3] rounded-card bg-card" />
              <div className="mt-2 h-4 w-3/4 rounded bg-card" />
              <div className="mt-1 h-3 w-1/2 rounded bg-card" />
            </div>
          ))}
        </div>
      )}

      {!isPending && !error && books.length === 0 && (
        <EmptyState
          icon={<Library size={28} strokeWidth={1.75} aria-hidden />}
          title="No books yet"
          description="Upload your first EPUB, PDF or Kindle file."
          action={
            <Link
              to="/upload"
              className="mt-2 inline-flex h-12 items-center justify-center rounded-pill bg-brand-gradient px-6 font-display font-semibold text-white"
            >
              Upload a book
            </Link>
          }
        />
      )}

      {!isPending && books.length > 0 && (
        <div className={GRID}>
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>
      )}

      {data && pages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="min-h-11 rounded-pill px-4 text-sm font-medium text-muted disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="min-h-11 rounded-pill px-4 text-sm font-medium text-muted disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
