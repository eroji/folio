import { Icon } from "./Icon";

/** Cover progress state (Direction D replaces the old percentage badge):
 * in progress → a 4px accent bar along the bottom edge of the cover;
 * finished → a round accent check in the corner; not started → nothing.
 * `aria-hidden` — the cover's accessible name carries the state instead.
 * Used by the book page cover and the grid/list cards. */
export function CoverProgressBadge({ percent, finished }: { percent: number | null; finished: boolean }) {
  if (finished) {
    return (
      <span
        aria-hidden
        className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-accent text-on-fg shadow-(--shadow-menu)"
      >
        <Icon name="Check" size={14} />
      </span>
    );
  }
  if (percent == null || percent <= 0) return null;
  return (
    <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-fg/25">
      <span className="block h-full bg-accent" style={{ width: `${Math.min(100, percent)}%` }} />
    </span>
  );
}
