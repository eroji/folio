import { useLocation, useNavigate } from "react-router-dom";
import { Pause, Play } from "lucide-react";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";

/** Screen 7: fixed bar above the bottom nav; tapping it opens the full player. */
export function MiniPlayer() {
  const player = usePlayer();
  const location = useLocation();
  const navigate = useNavigate();
  const book = player.book;
  if (!book || location.pathname === "/player") return null;

  // Character-based whole-book progress (spec "Progress model"), not chapter audio duration.
  const percent = player.progressPercent;

  return (
    <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-card/95 backdrop-blur md:hidden">
      <div aria-hidden className="h-0.5 w-full bg-line">
        <div className="h-full bg-brand-gradient" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          aria-label="Open player"
          onClick={() => navigate(`/player?book=${book.id}`)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
        >
          <BookCover book={book} className="h-10 w-10 shrink-0 rounded-card" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{player.chapter?.title ?? book.title}</span>
            <span className="block truncate text-xs text-muted">{book.title}</span>
          </span>
        </button>
        <button
          type="button"
          aria-label={player.playing ? "Pause" : "Play"}
          onClick={player.toggle}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-brand-gradient text-white"
        >
          {player.playing ? <Pause size={20} strokeWidth={1.75} aria-hidden /> : <Play size={20} strokeWidth={1.75} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
