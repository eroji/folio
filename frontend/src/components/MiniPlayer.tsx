/** Phone mini player (handoff "Phone"): 64px raised bar directly above the
 * bottom nav while a book is loaded, with a 2px accent progress line on top.
 * Tapping the cover or titles opens the phone player. Hidden on /player,
 * where the full-screen player takes over. */
import { Link } from "react-router-dom";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { PlayButton, SkipButton } from "./PlayerControls";

export function MiniPlayer() {
  const player = usePlayer();
  const book = player.book;
  if (!book) return null;

  const total = player.chapterTotal;
  const percent = total > 0 ? Math.min(100, (player.chapterElapsed / total) * 100) : 0;

  return (
    <section
      aria-label="Now playing"
      className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 flex h-16 items-center gap-3 bg-raised px-3"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-border">
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <Link
        to="/player"
        aria-label={`Open player: ${player.chapter?.title ?? book.title}, ${book.title}`}
        className="flex min-w-0 flex-1 items-center gap-3 no-underline"
      >
        <BookCover book={book} className="aspect-[2/3] w-8 shrink-0 rounded-xs" />
        <span className="flex min-w-0 flex-col text-left">
          <span className="truncate text-md font-semibold text-fg">{player.chapter?.title}</span>
          <span className="truncate text-sm text-fg-2">{book.title}</span>
        </span>
      </Link>
      <SkipButton direction="back" />
      <PlayButton size={44} />
    </section>
  );
}
