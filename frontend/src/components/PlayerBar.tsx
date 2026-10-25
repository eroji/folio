/** Direction D player bar (handoff "Player bar"): 72px min, --color-surface,
 * 1px top border, a 3px accent progress line along its top edge. Shown on
 * ≥768px whenever a book is loaded — never tied to play/pause — and hidden
 * only when nothing is loaded (Close stops and unloads). No narrator voice
 * button: per-handoff it lives only in the book's ⋮ menu. */
import { Link, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { formatTime } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { Icon } from "./Icon";
import { ChapterNavButton, PlayButton, SkipButton, SleepButton, SpeedButton, iconButton, timeAgo } from "./PlayerControls";

export function PlayerBar() {
  const player = usePlayer();
  const location = useLocation();
  const navigate = useNavigate();
  const book = player.book;
  if (!book) return null;

  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  const percent = total > 0 ? (elapsed / total) * 100 : 0;
  const onPlayer = location.pathname === "/player";
  const subtitle =
    player.lastDevice && !player.playing
      ? `Paused · last played on ${player.lastDevice.label} ${timeAgo(player.lastDevice.at)}`
      : [book.title, book.authors.join(", ")].filter(Boolean).join(" · ");

  return (
    <section
      aria-label="Now playing"
      className="fixed inset-x-0 bottom-0 z-20 flex min-h-[72px] flex-wrap items-center justify-between gap-2 border-t border-border bg-surface px-4 pb-safe"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-border">
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <ChapterNavButton delta={-1} />
        <SkipButton direction="back" />
        <PlayButton size={48} />
        <SkipButton direction="forward" />
        <ChapterNavButton delta={1} />
        <span className="ml-3 whitespace-nowrap text-sm tabular text-fg-2">
          {formatTime(elapsed)} / {formatTime(total)}
        </span>
      </div>

      <Link to="/player" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg no-underline hover:bg-raised md:max-w-[420px]">
        <BookCover book={book} className="aspect-[2/3] w-8 shrink-0 rounded-xs" />
        <span className="flex min-w-0 flex-col text-left">
          <span className="truncate text-md font-semibold text-fg">{player.chapter?.title}</span>
          <span className="truncate text-sm text-fg-2">{subtitle}</span>
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        <SpeedButton />
        <SleepButton />
        <button
          type="button"
          aria-label="Stop and close player"
          title="Stop and close player"
          onClick={player.stop}
          className={clsx(iconButton, "text-fg-2")}
        >
          <Icon name="X" size={22} />
        </button>
        {onPlayer ? (
          <button
            type="button"
            aria-label="Close player"
            title="Close player"
            onClick={() => navigate(`/books/${book.id}`)}
            className={iconButton}
          >
            <Icon name="ChevronDown" size={22} />
          </button>
        ) : (
          <Link to="/player" aria-label="Open player" title="Open player" className={clsx(iconButton, "no-underline")}>
            <Icon name="ChevronUp" size={22} />
          </Link>
        )}
      </div>
    </section>
  );
}
