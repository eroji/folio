import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

/** ⋯ book menu (handoff "Book page" item 3), visible to every listener:
 * Mark as finished / Mark as unfinished and Reset progress. The menu sizes to
 * its content; rows are 30 px with a mouse and 34 px on touch.
 * variant "inline": 36 px bordered trigger next to the primary action
 * (desktop); variant "header": borderless trigger for the phone header slot. */
export function BookMenu({
  finished,
  pending,
  onToggleFinished,
  onReset,
  variant = "inline",
}: {
  finished: boolean;
  pending: boolean;
  onToggleFinished: (finished: boolean) => void;
  onReset: () => void;
  variant?: "inline" | "header";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Same menu-button keyboard pattern as AccountMenu: arrows open/cycle,
  // Escape closes and returns focus to the trigger.
  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    const items = itemsRef.current
      ? Array.from(itemsRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focus = (next: number) => {
      event.preventDefault();
      items[((next % items.length) + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(items.length - 1);
  }

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More options for this book"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          "tap grid place-items-center rounded-md text-fg",
          variant === "header"
            ? "size-11 hover:bg-raised"
            : "size-9 border border-control-border bg-surface hover:bg-raised",
        )}
      >
        <Icon name="more_horiz" size={variant === "header" ? 22 : 20} />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => close(false)}
          />
          <div
            ref={itemsRef}
            role="menu"
            aria-label="Book options"
            className={clsx(
              "absolute z-40 w-max rounded-lg border border-divider bg-surface p-1 shadow-(--shadow-menu)",
              variant === "header" ? "top-full right-0" : "top-10 left-0",
            )}
          >
            <button
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => {
                close(false);
                onToggleFinished(!finished);
              }}
              className={menuItem}
            >
              <Icon name="task_alt" size={18} />
              {finished ? "Mark as unfinished" : "Mark as finished"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                onReset();
              }}
              className={menuItem}
            >
              <Icon name="restart_alt" size={18} />
              Reset progress
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const menuItem =
  "tap flex min-h-[34px] items-center gap-2 rounded-md pr-3 pl-2 text-left text-base whitespace-nowrap hover:bg-raised disabled:opacity-50 desktop:min-h-[30px]";
