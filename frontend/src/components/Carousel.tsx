/** Horizontal shelf row with 36px outlined arrow buttons (Direction D Home
 * and Library shelves). The row scrolls sideways with hidden scrollbars;
 * the arrows page by roughly one viewport. */
import { useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

export function useCarouselRow(items: ReactNode, gap = "gap-5") {
  const rowRef = useRef<HTMLDivElement>(null);
  const scroll = (direction: -1 | 1) => {
    const row = rowRef.current;
    row?.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: "smooth" });
  };
  const arrows = (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-label="Previous"
        title="Previous"
        onClick={() => scroll(-1)}
        className="tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-fg-2 hover:bg-raised"
      >
        <Icon name="ChevronLeft" size={20} />
      </button>
      <button
        type="button"
        aria-label="Next"
        title="Next"
        onClick={() => scroll(1)}
        className="tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised"
      >
        <Icon name="ChevronRight" size={20} />
      </button>
    </div>
  );
  const row = (
    <div ref={rowRef} className={`no-scrollbar flex ${gap} overflow-x-auto pb-1`}>
      {items}
    </div>
  );
  return { arrows, row };
}
