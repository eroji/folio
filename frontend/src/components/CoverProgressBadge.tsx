import { Icon } from "./Icon";

/** Cover progress state: in progress → the percent in a dark translucent pill
 * at the bottom-left plus a 4px accent bar along the bottom edge; finished →
 * a round accent check in the corner; not started → nothing.
 * `aria-hidden` — the cover's accessible name carries the state instead.
 * Used by the book page hero and the grid/list cards; covers below ~96 px
 * wide (32 px player thumb, 56 px rows) render no badge at all. */
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
    <>
      <span
        aria-hidden
        className="absolute bottom-1 left-1 rounded-full bg-bg/80 px-1.5 py-0.5 text-xs font-semibold tabular text-fg"
      >
        {Math.round(percent)}%
      </span>
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-fg/25">
        <span className="block h-full bg-accent" style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
    </>
  );
}
