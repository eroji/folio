import clsx from "clsx";
import { Icon } from "./Icon";

/** Dark progress tag on the bottom-left of any cover that represents a book
 * (handoff "Cover progress badge"): not started renders nothing, in progress
 * shows the overall percent, finished shows a check. `aria-hidden` — the
 * cover's accessible name carries the state instead. Reused by the Phase 5
 * library cards. */
export function CoverProgressBadge({ percent, finished }: { percent: number | null; finished: boolean }) {
  if (!finished && percent == null) return null;
  return (
    <span
      aria-hidden
      className={clsx(
        "absolute bottom-1 left-1 flex items-center rounded-sm bg-cover-badge px-1 py-px text-[10.5px] font-semibold leading-[1.3] tabular text-on-primary",
        "desktop:bottom-1.5 desktop:left-1.5 desktop:px-1.5 desktop:py-0.5 desktop:text-xs",
      )}
    >
      {finished ? <Icon name="check" size={12} /> : `${Math.round(percent ?? 0)}%`}
    </span>
  );
}
