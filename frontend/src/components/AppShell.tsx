import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../auth/AuthProvider";
import { useContinueListening } from "../api/progress";
import { useEvents } from "../hooks/useEvents";
import { AccountMenu } from "./AccountMenu";
import { FocusMode } from "./FocusMode";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { PlayerSurfaces, usePlayerCollapsed } from "./NowPlaying";
import { PlayerProvider } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import folioMark from "../assets/folio-mark.svg";

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

/** Focus mode is desktop-only; on phones the /player route is the full player. */
function isDesktop(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1050px)").matches;
}

function RailLink({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <Link to={to} aria-label={label} className={railItem({ isActive: false })}>
      <Icon name={icon} size={20} />
    </Link>
  );
}

/** Desktop ≥1050px: 60px icon rail on the left; when a book is loaded the
 * Now Playing panel takes the right half of the remaining width (or a 64px
 * bar along the bottom when collapsed). Below: 48px phone header (back, ⋯),
 * 56px tab bar and the Now Playing sheet pinned above it. */
function Shell() {
  const { user } = useAuth();
  const player = usePlayer();
  useEvents();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, toggleCollapse] = usePlayerCollapsed();
  const [focus, setFocus] = useState(false);

  // Handoff "When the player shows": load the most recently played book,
  // paused, once per app start, so Resume is one click from any page.
  const { data: continueData } = useContinueListening(1);
  const p = useRef(player);
  p.current = player;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || p.current.book) {
      started.current = true;
      return;
    }
    // On /player?book=… the route owns the load; do not race it.
    if (location.pathname === "/player" && new URLSearchParams(location.search).get("book")) return;
    const item = continueData?.items[0];
    if (item) {
      started.current = true;
      void p.current.load(item.book.id, item.progress.chapter_id);
    }
  }, [continueData, location]);

  // Shortcuts: P collapses/expands the panel, F opens focus mode, Esc exits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return;
      if (event.key === "Escape") {
        if (focusRef.current) setFocus(false);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || focusRef.current || !p.current.book) return;
      const key = event.key.toLowerCase();
      if (key === "p") toggleCollapse();
      else if (key === "f" && isDesktop()) setFocus(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapse]);

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
          <img src={folioMark} alt="Folio" width={28} height={28} />
        </Link>
        <NavLink to="/" end aria-label="Library" className={railItem}>
          <Icon name="auto_stories" size={20} />
        </NavLink>
        <RailLink to={SEARCH_HREF} icon="search" label="Search" />
        <NavLink to="/upload" aria-label="Upload" className={railItem}>
          <Icon name="upload" size={20} />
        </NavLink>
        <div className="relative mt-auto">
          <AccountMenu placement="rail" />
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
        {/* On a book page the header ⋯ is the book menu (rendered by
            BookDetailPage); the account items live on the "You" tab. */}
        {/^\/books\/[^/]+$/.test(location.pathname) ? (
          <span className="size-11" aria-hidden />
        ) : (
          <AccountMenu placement="header" />
        )}
      </header>

      <main
        className={clsx(
          "min-w-0 px-4 pt-[calc(3rem+env(safe-area-inset-top))] desktop:pt-5 desktop:pl-[88px]",
          player.book ? "pb-[calc(9rem+env(safe-area-inset-bottom))]" : "pb-[calc(5rem+env(safe-area-inset-bottom))]",
          player.book && !collapsed
            ? "desktop:pr-[calc(50vw-2px)] desktop:pb-10"
            : "desktop:pr-7",
          player.book && collapsed && "desktop:pb-24",
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
        <AccountMenu placement="sheet" />
      </nav>

      <PlayerSurfaces collapsed={collapsed} onToggleCollapse={toggleCollapse} onFocus={() => setFocus(true)} />
      {focus && player.book && <FocusMode onExit={() => setFocus(false)} />}
    </div>
  );
}
