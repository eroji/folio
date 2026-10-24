import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { BookOpen, Moon, Shield, Sun, Upload } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { useEvents } from "../hooks/useEvents";
import { useTheme } from "../hooks/useTheme";

const iconProps = { size: 20, strokeWidth: 1.75, "aria-hidden": true } as const;

/** Sticky header (logo, nav, theme toggle, avatar menu) + phone bottom nav. */
export function AppShell() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  useEvents();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return null; // RequireAuth guarantees a user before this renders.

  const wordmark = theme === "dark" ? "/logo-wordmark-dark.svg" : "/logo-wordmark.svg";

  async function signOut() {
    setMenuOpen(false);
    await logout();
    navigate("/login", { replace: true });
  }

  const topLink = ({ isActive }: { isActive: boolean }) =>
    clsx(
      "flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-medium",
      isActive ? "text-brand-blue" : "text-muted hover:text-ink",
    );
  const bottomLink = ({ isActive }: { isActive: boolean }) =>
    clsx(
      "flex min-h-11 flex-col items-center justify-center gap-0.5 py-1.5 text-xs font-medium",
      isActive ? "text-brand-blue" : "text-muted",
    );

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-page/90 pt-safe backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-4">
          <Link to="/" aria-label="Folio home" className="mr-2 flex min-h-11 items-center">
            <img src={wordmark} alt="Folio" className="h-7 w-auto" />
          </Link>
          <nav className="hidden gap-1 md:flex" aria-label="Primary">
            <NavLink to="/" end className={topLink}>
              <BookOpen {...iconProps} /> Library
            </NavLink>
            <NavLink to="/upload" className={topLink}>
              <Upload {...iconProps} /> Upload
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center">
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="grid h-11 w-11 place-items-center rounded-pill text-muted hover:text-ink"
            >
              {theme === "dark" ? <Sun {...iconProps} size={22} /> : <Moon {...iconProps} size={22} />}
            </button>
            <div className="relative">
              <button
                type="button"
                aria-label="Account menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
                className="grid h-11 w-11 place-items-center rounded-pill bg-brand-gradient font-display text-sm font-semibold text-white"
              >
                {user.display_name.slice(0, 1).toUpperCase()}
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute right-0 z-20 mt-1 w-60 rounded-card border border-line bg-card p-1 shadow-lg">
                    <div className="px-3 py-2">
                      <p className="font-medium">{user.display_name}</p>
                      <p className="text-sm text-muted">{user.username}</p>
                    </div>
                    {user.role === "admin" && (
                      <Link
                        to="/admin"
                        onClick={() => setMenuOpen(false)}
                        className="flex min-h-11 items-center gap-2 rounded-card px-3 text-sm hover:bg-page"
                      >
                        <Shield {...iconProps} size={18} /> Admin
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={signOut}
                      className="flex min-h-11 w-full items-center rounded-card px-3 text-left text-sm hover:bg-page"
                    >
                      Log out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-24 pt-4 md:pb-10">
        <Outlet />
      </main>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-page/95 pb-safe backdrop-blur md:hidden"
      >
        <div className="mx-auto grid max-w-md grid-flow-col">
          <NavLink to="/" end className={bottomLink}>
            <BookOpen {...iconProps} size={22} />
            <span>Library</span>
          </NavLink>
          <NavLink to="/upload" className={bottomLink}>
            <Upload {...iconProps} size={22} />
            <span>Upload</span>
          </NavLink>
          {user.role === "admin" && (
            <NavLink to="/admin" className={bottomLink}>
              <Shield {...iconProps} size={22} />
              <span>Admin</span>
            </NavLink>
          )}
        </div>
      </nav>
    </div>
  );
}
