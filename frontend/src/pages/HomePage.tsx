/** Home (Direction D §4): filter chips and the Continue listening, Next
 * chapters and Recently added shelves from GET /me/home. Clicking a Continue
 * card resumes playback in place; its href still points at /player so the
 * card works without JS (docs/DECISIONS.md). */
import { useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../auth/AuthProvider";
import {
  formatLength,
  nativeLanguageName,
  useHome,
  type HomeContinueItem,
  type HomeFilters,
  type HomeNextItem,
} from "../api/books";
import { useProgressMembership } from "../api/progress";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "../components/BookCard";
import { useCarouselRow } from "../components/Carousel";
import { CoverProgressBadge } from "../components/CoverProgressBadge";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { Book } from "../api/types";

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
    <span className="relative block aspect-[2/3] overflow-hidden rounded-cover shadow-(--shadow-cover)">
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
  return item.chapter ? `Ch. ${item.chapter.idx + 1} · ${left}` : left;
}

/** Reference copy for chapter lengths: "18 min", but "2 h 36 m" beyond an hour. */
function chapterLength(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : formatLength(seconds);
}

function NextChapterRow({ item, onStart }: { item: HomeNextItem; onStart: () => void }) {
  return (
    <button
      type="button"
      onClick={onStart}
      className="tap flex min-w-0 items-center gap-3.5 rounded-lg px-1 py-1.5 text-left hover:bg-raised"
    >
      <BookCover book={item.book} className="aspect-[2/3] w-9 shrink-0 rounded-xs" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-md font-semibold">
          {item.chapter.idx + 1} · {item.chapter.title}
        </span>
        <span className="truncate text-base text-fg-2">
          {item.book.title}
          {item.chapter.duration_s != null && ` · ${chapterLength(item.chapter.duration_s)}`}
        </span>
      </span>
    </button>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const player = usePlayer();
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
  const next = data?.next_chapters ?? [];
  const recent = data?.recent ?? [];
  const languages = [
    ...new Set([...recent, ...items.map((item) => item.book)].map((book) => book.language)),
  ].sort();
  const empty = !isPending && !error && items.length + next.length + recent.length === 0;

  /** Load (or switch to) the book and start it playing, without navigating. */
  async function start(bookId: string, chapterId?: string) {
    if (player.book?.id !== bookId) await player.load(bookId, chapterId);
    else if (chapterId && player.chapter?.id !== chapterId) await player.goToChapter(chapterId);
    await player.play();
  }

  const cardWidth = phone ? "w-[140px]" : "w-[176px]";
  const continueRow = useCarouselRow(
    items.map((item) => (
      <div key={item.book.id} className={clsx("flex min-w-0 shrink-0 flex-col gap-2.5", cardWidth)}>
        <a
          href={`/player?book=${item.book.id}&chapter=${item.progress.chapter_id}`}
          aria-label={`${item.book.title}, ${
            item.progress.finished_at
              ? "finished"
              : item.progress.percent > 0
                ? `${Math.round(item.progress.percent)}% listened`
                : "not started"
          }, resume`}
          onClick={(event) => {
            event.preventDefault();
            void start(item.book.id, item.progress.chapter_id);
          }}
          className="rounded-cover no-underline"
        >
          <Cover
            book={item.book}
            percent={item.progress.finished_at ? null : Math.round(item.progress.percent)}
            finished={Boolean(item.progress.finished_at)}
          />
        </a>
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
          phone ? "no-scrollbar flex-nowrap overflow-x-auto" : "flex-wrap",
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
              <div className="aspect-[2/3] rounded-cover bg-raised" />
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
                <div className="flex min-w-0 flex-col gap-1">
                  {user && <span className="eyebrow truncate">{user.display_name}</span>}
                  <h2 className="font-display text-2xl">Continue listening</h2>
                </div>
                {continueRow.arrows}
              </div>
              {continueRow.row}
            </section>
          )}

          {next.length > 0 && (
            <section aria-label="Next chapters" className="flex flex-col gap-3.5">
              <div className="flex items-end justify-between gap-4">
                <h2 className="font-display text-2xl">Next chapters</h2>
                <button
                  type="button"
                  onClick={() => {
                    const first = (phone ? next.slice(0, 3) : next)[0];
                    if (first) void start(first.book.id, first.chapter.id);
                  }}
                  className="tap inline-flex h-9 shrink-0 items-center rounded-full border border-border px-4 text-base font-semibold text-fg hover:bg-raised"
                >
                  Play next
                </button>
              </div>
              <div className="grid gap-x-8 gap-y-1 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {(phone ? next.slice(0, 3) : next).map((item) => (
                  <NextChapterRow
                    key={item.chapter.id}
                    item={item}
                    onStart={() => void start(item.book.id, item.chapter.id)}
                  />
                ))}
              </div>
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
        </>
      )}
    </div>
  );
}
