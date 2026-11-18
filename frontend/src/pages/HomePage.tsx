/** Home (Direction D §4): filter chips, the Continue listening and Recently
 * added shelves from GET /me/home, and a "Browse by genre" block
 * of genre shelves from GET /books?group=genre. A Continue card's cover and
 * title both link to the book; playback resumes from there (docs/DECISIONS.md). */
import { useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import {
  formatLength,
  nativeLanguageName,
  useBookGroups,
  useHome,
  type BookGroupShelf,
  type HomeContinueItem,
  type HomeFilters,
} from "../api/books";
import { useProgressMembership } from "../api/progress";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { BookCard, BookCover } from "../components/BookCard";
import { useCarouselRow } from "../components/Carousel";
import { CoverProgressBadge } from "../components/CoverProgressBadge";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { Book, Progress } from "../api/types";

const STATUS_CHIPS = [
  { value: "all", label: "All" },
  { value: "in_progress", label: "In progress" },
  { value: "not_started", label: "Not started" },
  { value: "finished", label: "Finished" },
] as const;

const SHORT = "short";
const UNDER_3H_MINUTES = 180;

function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={clsx(
        "tap inline-flex h-[34px] shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-base",
        selected
          ? "bg-accent font-bold text-on-fg"
          : "bg-raised font-medium text-fg hover:bg-border",
      )}
    >
      {label}
    </button>
  );
}

function Cover({ book, percent, finished }: { book: Book; percent: number | null; finished: boolean }) {
  return (
    <span className="relative block aspect-[2/3] overflow-hidden rounded-md shadow-(--shadow-cover)">
      <BookCover book={book} className="absolute inset-0 h-full w-full" />
      <CoverProgressBadge percent={percent} finished={finished} />
    </span>
  );
}

function CardText({
  book,
  meta,
  linked = true,
}: {
  book: Book;
  meta: string;
  /** Inside a whole-card link the title must not nest another anchor. */
  linked?: boolean;
}) {
  const title = (
    <span
      lang={book.language}
      title={book.title}
      className="truncate text-md font-semibold"
    >
      {book.title}
    </span>
  );
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {linked ? (
        <Link to={`/books/${book.id}`} className="text-fg no-underline hover:underline">
          {title}
        </Link>
      ) : (
        title
      )}
      <span className="truncate text-base tabular text-fg-2">{meta}</span>
    </span>
  );
}

function continueMeta(item: HomeContinueItem): string {
  const left = `${formatLength(item.time_left_s)} left`;
  return item.chapter ? `Ch. ${item.chapter.number ?? item.chapter.idx + 1} · ${left}` : left;
}

/** One genre shelf in the "Browse by genre" block: same shape as the Library
 * genre shelves (name + count, "See all" pill, 150px cover cards) with Home's
 * pill styling. `count` is the number of books the current chips leave. */
function GenreShelf({
  shelf,
  books,
  count,
  progressById,
}: {
  shelf: BookGroupShelf;
  books: Book[];
  count: number;
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
    <section aria-label={shelf.label} className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-baseline gap-2.5 font-display text-xl">
          <span className="truncate">{shelf.label}</span>
          <span className="font-ui text-md font-medium tracking-normal text-fg-2 tabular">
            {count}
          </span>
        </h3>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to={`/library?group=none&genre=${encodeURIComponent(shelf.key ?? "none")}`}
            className="tap inline-flex h-9 items-center rounded-full border border-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised"
          >
            See all
          </Link>
          {books.length > 8 && arrows}
        </div>
      </div>
      {row}
    </section>
  );
}

export function HomePage() {
  const phone = !useMediaQuery("(min-width: 768px)");
  const [chip, setChip] = useState<string>("all");

  const filters: HomeFilters =
    chip === "all"
      ? {}
      : chip === SHORT
        ? { maxMinutes: UNDER_3H_MINUTES }
        : chip.startsWith("lang:")
          ? { language: chip.slice(5) }
          : { status: chip as HomeFilters["status"] };
  const { data, isPending, error } = useHome(filters);
  const { progressById } = useProgressMembership();

  const items = data?.continue ?? [];
  const recent = data?.recent ?? [];
  const languages = [
    ...new Set([...recent, ...items.map((item) => item.book)].map((book) => book.language)),
  ].sort();
  const empty = !isPending && !error && items.length + recent.length === 0;

  /** Genre shelves: GET /books?group=genre honours the status chip; the language
   * and duration chips have no server parameter, so they filter the loaded
   * books client-side like the Library chips do.
   * ponytail: counts are the API's whole-genre counts; a client-side filter
   * shows the filtered count and can drop a genre whose matches sit past the
   * 12 books the grouped listing returns. Send language/max_minutes to
   * GET /books once the API accepts them. */
  const { data: grouped } = useBookGroups(
    { group: "genre", sort: "recent", status: filters.status },
    { enabled: !empty },
  );
  const filtered = Boolean(filters.language || filters.maxMinutes);
  const matchesChips = (book: Book): boolean =>
    (!filters.language || book.language === filters.language) &&
    (!filters.maxMinutes ||
      // Like GET /me/home: books without a known length are not "under" anything.
      (book.est_duration_s != null && book.est_duration_s <= filters.maxMinutes * 60));
  const genreShelves = (grouped?.groups ?? [])
    .map((shelf) => ({ shelf, books: shelf.books.filter(matchesChips) }))
    .filter(({ books }) => books.length > 0)
    .sort(
      (a, b) =>
        Number(a.shelf.key === null) - Number(b.shelf.key === null) || b.shelf.count - a.shelf.count,
    );

  const cardWidth = phone ? "w-[140px]" : "w-[176px]";
  const continueRow = useCarouselRow(
    items.map((item) => (
      <div key={item.book.id} className={clsx("flex min-w-0 shrink-0 flex-col gap-2.5", cardWidth)}>
        <Link
          to={`/books/${item.book.id}`}
          aria-label={`${item.book.title}, ${
            item.progress.finished_at
              ? "finished"
              : item.progress.percent > 0
                ? `${Math.round(item.progress.percent)}% listened`
                : "not started"
          }`}
          className="rounded-md no-underline"
        >
          <Cover
            book={item.book}
            percent={item.progress.finished_at ? null : Math.round(item.progress.percent)}
            finished={Boolean(item.progress.finished_at)}
          />
        </Link>
        <CardText book={item.book} meta={continueMeta(item)} />
      </div>
    )),
  );
  const recentRow = useCarouselRow(
    recent.map((book) => {
      const progress = progressById.get(book.id);
      return (
        <Link
          key={book.id}
          to={`/books/${book.id}`}
          className={clsx("flex min-w-0 shrink-0 flex-col gap-2.5 no-underline", cardWidth)}
        >
          <Cover
            book={book}
            percent={progress && !progress.finished_at ? Math.round(progress.percent) : null}
            finished={Boolean(progress?.finished_at)}
          />
          <CardText
            book={book}
            linked={false}
            meta={`${book.authors.join(", ") || "Unknown author"}${
              book.est_duration_s ? ` · ${formatLength(book.est_duration_s)}` : ""
            }`}
          />
        </Link>
      );
    }),
  );

  return (
    <div className="flex flex-col gap-8">
      <div
        role="group"
        aria-label="Filter"
        className={clsx(
          "flex gap-2.5",
          phone ? "no-scrollbar flex-nowrap overflow-x-auto pt-2" : "flex-wrap",
        )}
      >
        {STATUS_CHIPS.map(({ value, label }) => (
          <Chip key={value} label={label} selected={chip === value} onClick={() => setChip(value)} />
        ))}
        {languages.map((code) => (
          <Chip
            key={code}
            label={nativeLanguageName(code)}
            selected={chip === `lang:${code}`}
            onClick={() => setChip(`lang:${code}`)}
          />
        ))}
        <Chip label="Under 3 hours" selected={chip === SHORT} onClick={() => setChip(SHORT)} />
      </div>

      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}

      {isPending && !error && (
        <div aria-busy="true" className="flex gap-5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={clsx("animate-pulse", cardWidth)}>
              <div className="aspect-[2/3] rounded-md bg-raised" />
              <div className="mt-2.5 h-4 w-3/4 rounded bg-raised" />
            </div>
          ))}
        </div>
      )}

      {empty && (
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

      {!isPending && !empty && (
        <>
          {items.length > 0 && (
            <section aria-label="Continue listening" className="flex flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <h2 className="min-w-0 truncate font-display text-2xl">Continue listening</h2>
                {continueRow.arrows}
              </div>
              {continueRow.row}
            </section>
          )}

          {recent.length > 0 && (
            <section aria-label="Recently added" className="flex flex-col gap-4">
              <div className="flex items-end justify-between gap-4">
                <h2 className="font-display text-2xl">Recently added</h2>
                <div className="flex shrink-0 items-center gap-3">
                  <Link
                    to="/library?sort=recent&group=none"
                    className="tap inline-flex h-9 items-center rounded-full border border-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised"
                  >
                    See all
                  </Link>
                  {recentRow.arrows}
                </div>
              </div>
              {recentRow.row}
            </section>
          )}

          {genreShelves.length > 0 && (
            <section aria-label="Browse by genre" className="flex flex-col gap-8">
              <h2 className="font-display text-2xl">Browse by genre</h2>
              {genreShelves.map(({ shelf, books }) => (
                <GenreShelf
                  key={shelf.key ?? ""}
                  shelf={shelf}
                  books={books}
                  count={filtered ? books.length : shelf.count}
                  progressById={progressById}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
