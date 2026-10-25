/** Search (Direction D §4): the top bar field holds the query, type chips
 * filter through ?type=, and the page shows a polite count, a top result
 * card and result rows. */
import { Link, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { formatLength } from "../api/books";
import { useSearch, type SearchTop, type SearchType } from "../api/search";
import { useProgressMembership } from "../api/progress";
import type { Book, Progress } from "../api/types";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "../components/BookCard";
import { BookRowMenu } from "../components/BookRowMenu";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";

const TYPES: { value: SearchType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "books", label: "Books" },
  { value: "authors", label: "Authors" },
  { value: "series", label: "Series" },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matched text reads bold in the primary color, no background (reference). */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent font-bold text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function lengthLine(book: Book): string {
  return book.est_duration_s ? formatLength(book.est_duration_s) : "";
}

function metaLine(book: Book, progress: Progress | undefined): string {
  const tail = progress?.finished_at
    ? "Finished"
    : progress
      ? book.est_duration_s
        ? `${formatLength(book.est_duration_s * (1 - progress.percent / 100))} left`
        : `${Math.round(progress.percent)}% done`
      : lengthLine(book);
  return `Book · ${book.authors.join(", ") || "Unknown author"}${tail ? ` · ${tail}` : ""}`;
}

const whitePill =
  "tap inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-fg px-[18px] text-md font-bold text-on-fg no-underline";
const outlinedPill =
  "tap inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border px-4 text-md font-semibold text-fg no-underline hover:bg-raised";

/** The top result card: an author (round avatar, counts, Play/View books)
 * or a book (cover, Resume/Play/Open). */
function TopResult({
  top,
  books,
  progressById,
  onPlay,
}: {
  top: SearchTop | null;
  books: Book[];
  progressById: Map<string, Progress>;
  onPlay: (book: Book, progress?: Progress) => void;
}) {
  if (!top) return null;

  if (top.type === "author") {
    const authored = books.filter((book) => book.authors.includes(top.name));
    const playable =
      authored
        .filter((book) => {
          const progress = progressById.get(book.id);
          return progress && !progress.finished_at;
        })
        .sort((a, b) =>
          (progressById.get(b.id)?.updated_at ?? "").localeCompare(
            progressById.get(a.id)?.updated_at ?? "",
          ),
        )[0] ?? authored[0];
    return (
      <section aria-label="Top result" className="flex max-w-[460px] flex-col gap-3.5">
        <h2 className="font-display text-xl">Top result</h2>
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6">
          <div className="flex items-center gap-4">
            <span
              aria-hidden
              className="grid size-24 shrink-0 place-items-center rounded-full bg-raised text-fg-2"
            >
              <Icon name="User" size={44} />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-display text-[28px]">{top.name}</span>
              <span className="text-base text-fg-2 tabular">
                Author · {top.count} {top.count === 1 ? "book" : "books"} · {top.finished} finished
              </span>
            </span>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {playable && (
              <button type="button" onClick={() => onPlay(playable)} className={whitePill}>
                <Icon name="Play" size={20} />
                Play
              </button>
            )}
            <Link to={`/search?q=${encodeURIComponent(top.name)}&type=books`} className={outlinedPill}>
              View books
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const book = top.book;
  const progress = progressById.get(book.id);
  const resume = Boolean(progress && !progress.finished_at && progress.percent > 0);
  return (
    <section aria-label="Top result" className="flex max-w-[460px] flex-col gap-3.5">
      <h2 className="font-display text-xl">Top result</h2>
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6">
        <div className="flex items-center gap-4">
          <Link
            to={`/books/${book.id}`}
            aria-label={book.title}
            className="block aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-md shadow-(--shadow-cover) no-underline"
          >
            <BookCover book={book} className="h-full w-full" />
          </Link>
          <span className="flex min-w-0 flex-col gap-1">
            <Link
              to={`/books/${book.id}`}
              lang={book.language}
              className="font-display text-[28px] text-fg no-underline hover:underline"
            >
              {book.title}
            </Link>
            <span className="text-base text-fg-2 tabular">
              Book · {book.authors.join(", ") || "Unknown author"}
              {lengthLine(book) && ` · ${lengthLine(book)}`}
            </span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={() => onPlay(book, resume ? progress : undefined)}
            className={whitePill}
          >
            <Icon name="Play" size={20} />
            {resume ? "Resume" : "Play"}
          </button>
          <Link to={`/books/${book.id}`} className={outlinedPill}>
            Open
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Name + count rows for the Authors and Series chips; the name becomes
 * the next query. */
function GroupList({
  label,
  query,
  groups,
}: {
  label: string;
  query: string;
  groups: { name: string; count: number }[];
}) {
  if (groups.length === 0) return null;
  return (
    <section aria-label={label} className="flex min-w-0 flex-1 flex-col gap-2.5">
      <h2 className="font-display text-xl">{label}</h2>
      {groups.map((group) => (
        <Link
          key={group.name}
          to={`/search?q=${encodeURIComponent(group.name)}`}
          className="tap flex min-w-0 items-center justify-between gap-4 rounded-lg px-2 py-1.5 no-underline hover:bg-raised"
        >
          <span className="min-w-0 truncate text-md font-semibold text-fg">
            <Highlight text={group.name} query={query} />
          </span>
          <span className="shrink-0 text-base text-fg-2 tabular">
            {group.count} {group.count === 1 ? "book" : "books"}
          </span>
        </Link>
      ))}
    </section>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const type = (TYPES.find(({ value }) => value === params.get("type"))?.value ?? "all") as SearchType;
  const { data, isPending, error } = useSearch(query, type);
  const { progressById } = useProgressMembership();
  const player = usePlayer();

  /** Load (or switch to) the book and start it playing, without navigating. */
  async function play(book: Book, progress?: Progress) {
    if (player.book?.id !== book.id) await player.load(book.id, progress?.chapter_id);
    else if (progress && player.chapter?.id !== progress.chapter_id)
      await player.goToChapter(progress.chapter_id);
    await player.play();
  }

  if (!query) {
    return <p className="text-sm text-fg-2">Type in the search field to find books, authors and series.</p>;
  }

  const total = (data?.books.length ?? 0) + (data?.authors.length ?? 0) + (data?.series.length ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div role="group" aria-label="Result type" className="flex flex-wrap gap-2.5">
        {TYPES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={type === value}
            onClick={() =>
              setParams((current) => {
                const next = new URLSearchParams(current);
                if (value === "all") next.delete("type");
                else next.set("type", value);
                return next;
              })
            }
            className={clsx(
              "tap inline-flex h-[34px] shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-base",
              type === value ? "bg-accent font-bold text-on-fg" : "bg-raised font-medium text-fg hover:bg-border",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}

      {isPending && !error && (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-raised" />
          ))}
        </div>
      )}

      {data && (
        <>
          <p role="status" className="-mt-3 text-base text-fg-2 tabular">
            {total} {total === 1 ? "result" : "results"} for “{query}”
          </p>
          {total === 0 ? (
            <EmptyState
              icon={<Icon name="Search" size={28} />}
              title={`No books match “${query}”`}
              action={
                <Link
                  to="/upload"
                  className="tap inline-flex h-10 items-center rounded-full bg-fg px-[18px] text-lg font-bold text-on-fg no-underline"
                >
                  Upload books
                </Link>
              }
            />
          ) : (
            <div className="flex flex-wrap items-start gap-8">
              <TopResult
                top={data.top}
                books={data.books}
                progressById={progressById}
                onPlay={(book, progress) => void play(book, progress)}
              />
              {data.books.length > 0 && (
                <section aria-label="Books" className="flex min-w-0 flex-[2] flex-col gap-2.5">
                  <h2 className="font-display text-xl">Books</h2>
                  {data.books.map((book) => {
                    const progress = progressById.get(book.id);
                    return (
                      <div key={book.id} className="flex items-center gap-4 rounded-lg px-2 py-2">
                        <span
                          aria-hidden
                          className="relative block aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-xs shadow-(--shadow-cover)"
                        >
                          <BookCover book={book} className="absolute inset-0 h-full w-full" />
                        </span>
                        <Link
                          to={`/books/${book.id}`}
                          lang={book.language}
                          className="flex min-w-0 flex-1 flex-col gap-0.5 text-fg no-underline"
                        >
                          <span className="truncate text-md font-semibold">
                            <Highlight text={book.title} query={query} />
                          </span>
                          <span className="truncate text-base text-fg-2">
                            <Highlight text={metaLine(book, progress)} query={query} />
                          </span>
                        </Link>
                        {progress?.finished_at && (
                          <span className="shrink-0 text-fg-2" title="Finished">
                            <Icon name="Check" size={18} />
                          </span>
                        )}
                        <BookRowMenu book={book} progress={progress ?? null} />
                      </div>
                    );
                  })}
                </section>
              )}
              <GroupList label="Authors" query={query} groups={type === "authors" ? data.authors : []} />
              <GroupList label="Series" query={query} groups={type === "series" ? data.series : []} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
