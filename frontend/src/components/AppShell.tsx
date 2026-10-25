import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../auth/AuthProvider";
import { useEvents } from "../hooks/useEvents";
import { useTheme } from "../hooks/useTheme";
import { AccountMenu } from "./AccountMenu";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { MiniPlayer } from "./MiniPlayer";
import { PlayerProvider } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";

export function AppShell() {
  return (
    <PlayerProvider>
      <Shell />
    </PlayerProvider>
  );
}

const railItem = ({ isActive }: { isActive: boolean }) =>
  clsx(
    "tap grid size-10 place-items-center rounded-md",
    isActive ? "bg-selected text-fg" : "text-fg-2 hover:bg-raised hover:text-fg",
  );

const tabItem = ({ isActive }: { isActive: boolean }) =>
  clsx(
    "tap flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs",
    isActive ? "font-semibold text-accent-fg" : "font-medium text-fg-2",
  );

/** Search is not a route: it lands on the library with the field focused. */
const SEARCH_HREF = "/?focus=search";

function RailLink({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <Link to={to} aria-label={label} className={railItem({ isActive: false })}>
      <Icon name={icon} size={20} />
    </Link>
  );
}

/** Desktop ≥1050px: 60px icon rail, account menu at its bottom. Below:
 * 48px phone header (back, ⋯) and a 56px tab bar ending in the avatar. */
function Shell() {
  const { user } = useAuth();
  const player = usePlayer();
  const { choice, select } = useTheme();
  useEvents();
  const navigate = useNavigate();
  const location = useLocation();

  // "/" focuses the library search from anywhere except a field being typed in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      navigate(SEARCH_HREF);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  if (!user) return null; // RequireAuth guarantees a user before this renders.

  return (
    <div className="min-h-dvh">
      <nav
        aria-label="Main"
        className="fixed inset-y-0 left-0 z-20 hidden w-[60px] flex-col items-center gap-2 border-r border-divider bg-surface px-2.5 pt-3.5 pb-3.5 desktop:flex"
      >
        <Link to="/" aria-label="Folio home" className="mb-4">
          <img src="/logo.svg" alt="Folio" className="size-8" />
        </Link>
        <NavLink to="/" end aria-label="Library" className={railItem}>
          <Icon name="auto_stories" size={20} />
        </NavLink>
        <RailLink to={SEARCH_HREF} icon="search" label="Search" />
        <NavLink to="/upload" aria-label="Upload" className={railItem}>
          <Icon name="upload" size={20} />
        </NavLink>
        <div className="relative mt-auto">
          <AccountMenu placement="rail" choice={choice} onSelectTheme={select} />
        </div>
      </nav>

      <header className="fixed inset-x-0 top-0 z-20 flex h-12 items-center justify-between bg-bg/90 px-2 pt-safe backdrop-blur desktop:hidden">
        {location.pathname === "/" ? (
          <span className="size-11" aria-hidden />
        ) : (
          <button
            type="button"
            aria-label="Back"
            onClick={() => (location.key === "default" ? navigate("/") : navigate(-1))}
            className="tap grid size-11 place-items-center rounded-md text-fg"
          >
            <Icon name="chevron_left" size={22} />
          </button>
        )}
        <AccountMenu placement="header" choice={choice} onSelectTheme={select} />
      </header>

      <main
        className={clsx(
          "min-w-0 px-4 pt-[calc(3rem+env(safe-area-inset-top))] desktop:pt-5 desktop:pl-[88px] desktop:pr-7",
          player.book
            ? "pb-[calc(9rem+env(safe-area-inset-bottom))] desktop:pb-28"
            : "pb-[calc(5rem+env(safe-area-inset-bottom))] desktop:pb-10",
        )}
      >
        <Outlet />
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 flex h-14 border-t border-divider bg-surface pb-safe desktop:hidden"
      >
        <NavLink to="/" end className={tabItem}>
          <Icon name="auto_stories" size={22} />
          <span>Library</span>
        </NavLink>
        <Link to={SEARCH_HREF} className={tabItem({ isActive: false })}>
          <Icon name="search" size={22} />
          <span>Search</span>
        </Link>
        <NavLink to="/upload" className={tabItem}>
          <Icon name="upload" size={22} />
          <span>Upload</span>
        </NavLink>
        <AccountMenu placement="sheet" choice={choice} onSelectTheme={select} />
      </nav>

      <MiniPlayer />
    </div>
  );
}
