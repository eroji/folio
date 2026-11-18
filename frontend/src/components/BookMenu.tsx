import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

/** ⋮ book menu (Direction D "Book page" item 6), visible to every listener:
 * Mark as finished/unfinished, Reset progress, Narrator voice (only when
 * the caller passes onNarrator: row menus and the desktop book page, for
 * editors; the phone book page has a "Narrated by" row instead) and Go to
 * author. Raised fill, 12px
 * radius, 40px rows. variant "inline": 44px outlined pill trigger next to the
 * primary action (desktop); variant "header": borderless 44px trigger for the
 * phone header. Keyboard: arrows open/cycle, Escape closes and refocuses. */
export function BookMenu({
  finished,
  pending,
  onToggleFinished,
  onReset,
  onNarrator,
  onGoToAuthor,
  variant = "inline",
  bookTitle,
}: {
  finished: boolean;
  pending: boolean;
  onToggleFinished: (finished: boolean) => void;
  onReset: () => void;
  /** Omitted: no Narrator voice item (book page, or a book the listener can't edit). */
  onNarrator?: () => void;
  onGoToAuthor: () => void;
  variant?: "inline" | "header";
  /** Row menus name the book in the trigger's label (search reference); the
   * book page's single menu keeps the context-free "this book". */
  bookTitle?: string;
}) {
  const optionsLabel = `More options for ${bookTitle ?? "this book"}`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

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
    <div className="relative shrink-0" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={optionsLabel}
        title={optionsLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          "tap grid size-11 place-items-center rounded-full text-fg",
          variant === "header" ? "hover:bg-raised" : "border border-border hover:bg-raised",
        )}
      >
        <Icon name="EllipsisVertical" size={22} />
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
              "absolute z-40 w-max rounded-lg border border-border bg-raised p-2 shadow-(--shadow-menu)",
              variant === "header" ? "top-full right-0" : "top-12 left-0",
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
              <Icon name="CircleCheck" size={20} />
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
              <Icon name="RotateCcw" size={20} />
              Reset progress
            </button>
            {onNarrator && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close(false);
                  onNarrator();
                }}
                className={menuItem}
              >
                <Icon name="Speech" size={20} />
                Narrator voice
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(false);
                onGoToAuthor();
              }}
              className={menuItem}
            >
              <Icon name="User" size={20} />
              Go to author
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const menuItem =
  "tap flex min-h-10 w-full items-center gap-3.5 rounded-sm px-4 text-left text-md whitespace-nowrap text-fg hover:bg-border/60 disabled:opacity-50";
