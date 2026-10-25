import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../auth/AuthProvider";
import type { ThemeChoice } from "../hooks/useTheme";
import { Icon } from "./Icon";

/** Where the trigger lives; decides trigger look and menu anchoring.
 * rail: avatar at the rail bottom (popover to the right), header: ⋯ in the
 * phone header (popover below), sheet: "You" tab (bottom sheet). */
export type AccountPlacement = "rail" | "header" | "sheet";

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const row =
  "flex min-h-8 items-center gap-2 rounded-md px-2 pr-3 text-left text-base whitespace-nowrap hover:bg-raised";

/** Avatar trigger plus the account menu: identity header, Settings, Admin
 * (admins only), inline System/Light/Dark theme switch, Sign out. */
export function AccountMenu({
  placement,
  choice,
  onSelectTheme,
}: {
  placement: AccountPlacement;
  choice: ThemeChoice;
  onSelectTheme: (choice: ThemeChoice) => void;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  if (!user) return null; // RequireAuth guarantees a user before this renders.

  const initial = user.display_name.slice(0, 1).toUpperCase();

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // Menu-button pattern: ArrowDown opens from the trigger, arrows cycle the
  // items, Escape closes and returns focus.
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
      ? Array.from(itemsRef.current.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
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

  async function signOut() {
    setOpen(false);
    await logout();
    navigate("/login", { replace: true });
  }

  const triggerProps = {
    ref: triggerRef,
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: () => setOpen((value) => !value),
  };

  const menu = (
    <div ref={itemsRef} role="menu" aria-label="Account" className="flex flex-col">
      <div className="mb-1 flex items-center gap-2.5 border-b border-divider p-2">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-avatar text-on-avatar text-xs font-semibold"
        >
          {initial}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base font-semibold">{user.display_name}</span>
          <span className="text-xs text-fg-2">
            {user.username} · {user.role === "admin" ? "Administrator" : "Member"}
          </span>
        </span>
      </div>
      <Link to="/settings" role="menuitem" className={row} onClick={() => close(false)}>
        <Icon name="settings" size={18} /> Settings
      </Link>
      {user.role === "admin" && (
        <Link to="/admin" role="menuitem" className={row} onClick={() => close(false)}>
          <Icon name="admin_panel_settings" size={18} /> Admin
        </Link>
      )}
      <div role="group" aria-label="Theme" className="flex min-h-9 items-center justify-between gap-4 py-1 pl-2 pr-1">
        <span className="flex items-center gap-2 text-base">
          <Icon name="contrast" size={18} /> Theme
        </span>
        <span className="flex gap-0.5 rounded-md bg-raised p-0.5">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === theme.value}
              onClick={() => onSelectTheme(theme.value)}
              className={clsx(
                "h-6 rounded-sm px-2 text-xs",
                choice === theme.value
                  ? "bg-surface font-semibold text-fg shadow-sm"
                  : "font-medium text-fg-2",
              )}
            >
              {theme.label}
            </button>
          ))}
        </span>
      </div>
      <div aria-hidden className="my-1 h-px bg-divider" />
      <button type="button" role="menuitem" className={row} onClick={signOut}>
        <Icon name="logout" size={18} /> Sign out
      </button>
    </div>
  );

  return (
    <div className={clsx(placement === "sheet" ? "contents" : "relative")} onKeyDown={onKeyDown}>
      {placement === "header" ? (
        <button
          {...triggerProps}
          aria-label="Account menu"
          className="tap grid size-11 place-items-center rounded-md text-fg"
        >
          <Icon name="more_horiz" size={22} />
        </button>
      ) : placement === "sheet" ? (
        <button
          {...triggerProps}
          className="tap flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium text-fg-2"
        >
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-full bg-avatar text-on-avatar text-xs font-semibold"
          >
            {initial}
          </span>
          <span>You</span>
        </button>
      ) : (
        <button
          {...triggerProps}
          aria-label="Account menu"
          className="tap grid size-9 place-items-center rounded-full bg-avatar text-on-avatar text-sm font-semibold"
        >
          {initial}
        </button>
      )}
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => close(false)}
          />
          {placement === "sheet" ? (
            <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-lg border-t border-divider bg-surface p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-menu)]">
              {menu}
            </div>
          ) : (
            <div
              className={clsx(
                "absolute z-40 w-max rounded-lg border border-divider bg-surface p-1 shadow-[var(--shadow-menu)]",
                placement === "rail" ? "bottom-0 left-full ml-2" : "right-0 top-full",
              )}
            >
              {menu}
            </div>
          )}
        </>
      )}
    </div>
  );
}
