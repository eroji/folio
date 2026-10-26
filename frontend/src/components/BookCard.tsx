import { Link } from "react-router-dom";
import clsx from "clsx";
import { CoverProgressBadge } from "./CoverProgressBadge";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import type { Book, BookStatus, Progress } from "../api/types";

/** Cover image or the flat raised placeholder (Direction D). Thumbnails inside
 * the player/next-chapter rows pass `showPlaceholderText={false}`: at 32–56px
 * the title would wrap into an unreadable sliver. */
export function BookCover({
  book,
  className,
  showPlaceholderText = true,
}: {
  book: Book;
  className?: string;
  showPlaceholderText?: boolean;
}) {
  if (book.cover_url) {
    return (
      <img
        src={book.cover_url}
        alt=""
        loading="lazy"
        className={clsx("overflow-hidden bg-raised object-cover", className)}
      />
    );
  }
  return (
    <div
      className={clsx(
        "flex flex-col justify-end gap-1 overflow-hidden bg-raised p-3 text-fg",
        className,
      )}
      aria-hidden
    >
      {showPlaceholderText && (
        <>
          <p className="line-clamp-4 font-display text-sm font-semibold leading-tight">
            {book.title}
          </p>
          {book.authors[0] && (
            <p className="line-clamp-1 text-xs opacity-80">{book.authors[0]}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Status line for grid cards, shown only while the book is not ready
 * (handoff "Library"). */
const STATUS_LINES: Partial<
  Record<
    BookStatus,
    { label: string; icon: IconName; tone: string; spin?: boolean }
  >
> = {
  uploading: { label: "Processing…", icon: "RefreshCw", tone: "text-fg-2", spin: true },
  processing: { label: "Processing…", icon: "RefreshCw", tone: "text-fg-2", spin: true },
  needs_ocr: { label: "Needs OCR", icon: "TriangleAlert", tone: "text-warning" },
  failed: { label: "Couldn't process", icon: "TriangleAlert", tone: "text-danger" },
};

/** Progress state appended to a card's visible text (handoff "Cover progress badge"). */
export function coverName(
  book: Book,
  progress: Progress | null | undefined,
): string {
  if (progress?.finished_at) return "finished";
  if (progress && progress.percent > 0)
    return `${Math.round(progress.percent)}% listened`;
  return "";
}

/** Grid card (handoff "Library"): cover with progress badge, 2-line title,
 * author, and a status line only while the book is not ready. */
export function BookCard({
  book,
  progress,
  showPercent = true,
}: {
  book: Book;
  progress?: Progress | null;
  /** Cards show the percent pill; the book-page hero passes false. */
  showPercent?: boolean;
}) {
  const finished = Boolean(progress?.finished_at);
  const percent =
    !finished && progress && progress.percent > 0
      ? Math.round(progress.percent)
      : null;
  const status =
    book.status === "ready" ? undefined : STATUS_LINES[book.status];
  return (
    <Link to={`/books/${book.id}`} className="flex min-w-0 flex-col gap-2">
      {/* No aria-label: the accessible name is the visible title/author/status,
          so WCAG 2.5.3 cannot drift. State is appended for screen readers. */}
      <span className="relative block aspect-[2/3] overflow-hidden rounded-md shadow-(--shadow-cover)">
        <BookCover book={book} className="absolute inset-0 h-full w-full" />
        <CoverProgressBadge percent={percent} finished={finished} showPercent={showPercent} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 text-base font-semibold leading-[1.3]">
          {book.title}
        </span>
        <span className="truncate text-sm text-fg-2">
          {book.authors.join(", ") || "Unknown author"}
        </span>
        {status && (
          <span
            className={clsx("flex items-center gap-1 text-xs", status.tone)}
          >
            <Icon
              name={status.icon}
              size={14}
              className={status.spin ? "animate-spin" : undefined}
            />
            {status.label}
          </span>
        )}
      </span>
      {coverName(book, progress) && <span className="sr-only">{coverName(book, progress)}</span>}
    </Link>
  );
}
