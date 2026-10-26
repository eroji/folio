import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "./Icon";

const row = "flex min-h-10 items-center gap-3.5 rounded-sm px-4 text-left text-md whitespace-nowrap hover:bg-border";

function Avatar({ initial, size }: { initial: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-full bg-accent text-lg text-on-fg font-bold"
    >
      {initial}
    </span>
  );
}

/** Accent avatar plus the account menu: identity header, Profile, Admin
 * (admins only, gear icon), Sign out. Dark only — there is no theme control. */
export function AccountMenu({ size = 36 }: { size?: number }) {
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

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ width: size, height: size }}
        className="tap grid shrink-0 place-items-center rounded-full bg-accent text-on-fg text-md font-bold"
      >
        {initial}
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
          <div className="absolute right-0 top-full z-40 w-max rounded-lg border border-border bg-raised p-1 shadow-(--shadow-menu)">
            <div ref={itemsRef} role="menu" aria-label="Account" className="flex flex-col">
              <div className="mb-1.5 flex items-center gap-3 border-b border-border px-3 pt-1 pb-3">
                <Avatar initial={initial} size={40} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-md font-bold">{user.display_name}</span>
                  <span className="text-sm text-fg-2">
                    @{user.username}
                    {user.role === "admin" && " · Admin"}
                  </span>
                </span>
              </div>
              <Link to="/settings" role="menuitem" className={row} onClick={() => close(false)}>
                <Icon name="ManageAccounts" size={20} /> Profile
              </Link>
              {user.role === "admin" && (
                <Link to="/admin" role="menuitem" className={row} onClick={() => close(false)}>
                  <Icon name="Settings" size={20} /> Admin
                </Link>
              )}
              <div className="my-1.5 h-px bg-border" aria-hidden />
              <button type="button" role="menuitem" className={row} onClick={signOut}>
                <Icon name="LogOut" size={20} /> Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
