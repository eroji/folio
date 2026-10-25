/** Chapter row in the Direction D shape (handoff "Book page → Chapters"):
 * 52px row, number / title / length, played rows secondary with a Check,
 * the playing row raised with an accent AudioLines and a percent line.
 * Used by the book page and the player's Up next tab. */
import clsx from "clsx";
import { formatTime } from "../player/PlayerProvider";
import type { Chapter } from "../api/types";
import { Icon } from "./Icon";

export function ChapterRow({
  chapter,
  number,
  state,
  percent,
  seconds,
  onPlay,
}: {
  chapter: Chapter;
  number: number;
  state: "played" | "current" | null;
  /** Percent through this chapter (the playing row only). */
  percent?: number | null;
  /** Chapter length in seconds. */
  seconds: number;
  onPlay: () => void;
}) {
  const current = state === "current";
  const remaining = percent != null ? seconds * (1 - percent / 100) : 0;
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onPlay}
      className={clsx(
        "tap flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-left",
        current ? "bg-raised" : state === "played" ? "text-fg-2 hover:bg-raised/60" : "hover:bg-raised",
      )}
    >
      {current ? (
        <span className="flex w-8 shrink-0 justify-center text-accent">
          <Icon name="AudioLines" size={20} />
          <span className="sr-only">Playing,</span>
        </span>
      ) : (
        <span className="w-8 shrink-0 text-center text-md tabular text-fg-2">{number}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={clsx("truncate text-md", current ? "font-bold text-fg" : "font-medium")}>{chapter.title}</span>
        {current && percent != null && (
          <span className="text-xs tabular text-fg-2">
            {percent}% · {formatTime(remaining)} left
          </span>
        )}
      </span>
      <span className={clsx("shrink-0 text-sm tabular", current ? "text-fg" : "text-fg-2")}>{formatTime(seconds)}</span>
      {state === "played" && (
        <>
          <Icon name="Check" size={16} className="shrink-0" />
          <span className="sr-only">Played</span>
        </>
      )}
    </button>
  );
}
