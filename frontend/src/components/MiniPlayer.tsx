import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ChevronsLeft, ChevronsRight, FastForward, Pause, Play, RotateCcw, Square } from "lucide-react";
import { SPEED_MAX, SPEED_MIN, formatTime } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";

const iconButton = "grid h-11 w-11 shrink-0 place-items-center rounded-pill text-muted hover:text-ink";

/** Screen 7: Plex-style fixed 64px bottom bar on every viewport (above the
 * phone bottom nav on small screens, pinned to the viewport bottom on md+);
 * the cover carries the whole-book percent badge, the transport centers on
 * desktop, and <480px keeps only prev/play/next. Tapping the cover/titles
 * opens the full player. Hidden on /player itself. */
export function MiniPlayer() {
  const player = usePlayer();
  const location = useLocation();
  const navigate = useNavigate();
  const book = player.book;
  if (!book || location.pathname === "/player") return null;

  // Character-based whole-book progress (spec "Progress model"), not chapter audio duration.
  const percent = player.progressPercent;
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  const cycleSpeed = () => player.setRate(player.rate >= SPEED_MAX ? SPEED_MIN : player.rate + 0.25);

  return (
    <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-card/95 backdrop-blur md:bottom-0 md:pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-4 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <button
          type="button"
          aria-label="Open player"
          onClick={() => navigate(`/player?book=${book.id}`)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-card text-left transition-opacity duration-150 hover:opacity-85"
        >
          <span className="relative shrink-0">
            <BookCover book={book} className="h-14 w-14 rounded-card" />
            <span
              data-testid="mini-percent"
              className="absolute bottom-0.5 left-0.5 rounded-pill bg-black/60 px-1.5 py-px text-[10px] font-medium tabular-nums text-white"
            >
              {Math.round(percent)}%
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{book.title}</span>
            <span className="block truncate text-xs tabular-nums text-muted">
              {player.chapter?.title ? `${player.chapter.title} · ` : ""}
              {formatTime(elapsed)} / {formatTime(total)}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous chapter"
            onClick={() => void player.stepChapter(-1)}
            className={iconButton}
          >
            <ChevronsLeft size={20} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`Back ${player.settings.skip_back} seconds`}
            onClick={player.skipBack}
            className={clsx(iconButton, "hidden min-[480px]:grid")}
          >
            <RotateCcw size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={player.playing ? "Pause" : "Play"}
            onClick={player.toggle}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-brand-gradient text-white transition-opacity duration-150 hover:opacity-90"
          >
            {player.playing ? <Pause size={20} strokeWidth={1.75} aria-hidden /> : <Play size={20} strokeWidth={1.75} aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={`Forward ${player.settings.skip_forward} seconds`}
            onClick={player.skipForward}
            className={clsx(iconButton, "hidden min-[480px]:grid")}
          >
            <FastForward size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next chapter"
            onClick={() => void player.stepChapter(1)}
            className={iconButton}
          >
            <ChevronsRight size={20} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Stop"
            onClick={player.stop}
            className={clsx(iconButton, "hidden min-[480px]:grid")}
          >
            <Square size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Change playback speed"
            onClick={cycleSpeed}
            className="hidden h-11 min-w-11 place-items-center rounded-pill px-1 text-xs font-medium tabular-nums text-muted hover:text-ink min-[720px]:grid"
          >
            {player.rate}×
          </button>
        </div>
        <div aria-hidden className="hidden md:block" />
      </div>
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
        <div className="h-full bg-brand-gradient" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
