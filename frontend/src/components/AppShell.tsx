import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "../auth/AuthProvider";
import { useBook } from "../api/books";
import { useContinueListening, type ContinueItem } from "../api/progress";
import { useEvents } from "../hooks/useEvents";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { AccountMenu } from "./AccountMenu";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { MiniPlayer } from "./MiniPlayer";
import { PlayerBar } from "./PlayerBar";
import { coverGlow } from "./PlayerPage";
import { ResumePrompt } from "./ResumePrompt";
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

const NAV: { to: string; icon: IconName; label: string }[] = [
  { to: "/", icon: "House", label: "Home" },
  { to: "/library", icon: "LibraryBig", label: "Library" },
  { to: "/search", icon: "Search", label: "Search" },
  { to: "/upload", icon: "Upload", label: "Upload" },
];

/** Remembered sidebar collapse; tablet (768–1023) starts as the labelled rail. */
const SIDEBAR_KEY = "folio-sidebar-collapsed";

function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved !== null) return saved === "true";
    return typeof window.matchMedia === "function" && !window.matchMedia("(min-width: 1024px)").matches;
  });
  const toggle = useCallback(
    () =>
      setCollapsed((current) => {
        localStorage.setItem(SIDEBAR_KEY, String(!current));
        return !current;
      }),
    [],
  );
  return [collapsed, toggle];
}

function Logo({ size, textClass }: { size: number; textClass: string }) {
  return (
    <Link to="/" aria-label="Folio home" className="flex min-w-0 shrink-0 items-center gap-1.5 no-underline">
      <img src={folioMark} alt="" width={size} height={size} className="shrink-0" />
      <span aria-hidden className={clsx("font-display text-fg", textClass)}>
        folio
      </span>
    </Link>
  );
}

function SideNavItem({ to, icon, label, collapsed }: { to: string; icon: IconName; label: string; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        clsx(
          "flex min-h-12 shrink-0 items-center rounded-xl px-3.5 text-lg no-underline",
          collapsed ? "flex-col justify-center gap-0 px-0 py-0.5 leading-none" : "gap-4",
          isActive ? "bg-raised font-bold text-fg" : "font-medium text-fg hover:bg-raised/60",
        )
      }
    >
      <Icon name={icon} size={24} />
      <span className={clsx("truncate", collapsed && "text-2xs font-medium leading-none")}>{label}</span>
    </NavLink>
  );
}

/** ≥768px: labelled sidebar. Collapsed it narrows to an 80px rail of 48px
 * icon + 11px label stacks; the logo moves to the top bar just right of the
 * rail. Settings/Admin live in the account menu. Tablet starts collapsed. */
function Sidebar({
  collapsed,
  onToggle,
  inProgress,
}: {
  collapsed: boolean;
  onToggle: () => void;
  inProgress: ContinueItem[];
}) {
  return (
    <nav
      aria-label="Main"
      className={clsx(
        "sticky top-0 hidden h-dvh shrink-0 flex-col gap-1 overflow-y-auto px-3 pt-2 pb-4 md:flex",
        collapsed ? "w-20" : "w-[240px]",
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-0.5">
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggle}
          className="tap grid size-10 shrink-0 place-items-center rounded-full text-fg hover:bg-raised"
        >
          <Icon name="Menu" size={22} />
        </button>
      </div>
      {NAV.map((item) => (
        <SideNavItem key={item.to} {...item} collapsed={collapsed} />
      ))}
      {!collapsed && (
        <>
          <div className="mx-1 my-3 h-px shrink-0 bg-border" aria-hidden />
          <Link
            to="/upload"
            className="tap mb-3 flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-raised px-3 text-base font-semibold text-fg no-underline hover:bg-border"
          >
            <Icon name="Plus" size={20} /> Add books
          </Link>
          <span className="eyebrow shrink-0 px-3.5 pb-1">In progress</span>
          {inProgress.length === 0 ? (
            <p className="px-3.5 text-sm text-fg-2">Nothing in progress.</p>
          ) : (
            inProgress.map(({ book, progress }) => (
              <Link
                key={book.id}
                to={`/books/${book.id}`}
                className="flex min-w-0 flex-col gap-0.5 rounded-xl px-3.5 py-2 no-underline hover:bg-raised"
              >
                <span className="truncate text-base font-semibold text-fg">{book.title}</span>
                {/* ponytail: "38% · Chapter 3" — /me/continue exposes no chapter
                    number (docs/DECISIONS.md); add it when the API does. */}
                <span className="truncate text-xs tabular text-fg-2">{Math.round(progress.percent)}%</span>
              </Link>
            ))
          )}
        </>
      )}
    </nav>
  );
}

/** Top bar search pill: Enter goes to /search?q=; on /search it carries the
 * query with an accent border and a clear button. */
function TopBarSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const onSearch = location.pathname === "/search";
  const urlQ = onSearch ? new URLSearchParams(location.search).get("q") ?? "" : "";
  const [value, setValue] = useState(urlQ);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (onSearch) setValue(urlQ);
  }, [onSearch, urlQ]);

  // "/" focuses the search field from anywhere except a field being typed in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit() {
    const q = value.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="relative min-w-0 flex-[0_1_520px]"
    >
      <Icon
        name="Search"
        size={20}
        className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-2"
      />
      <input
        ref={ref}
        type="search"
        aria-label="Search books, authors, series"
        placeholder="Search books, authors, series"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        className={clsx(
          "h-11 w-full rounded-full bg-raised px-11 text-md text-fg outline-none placeholder:text-fg-2",
          onSearch ? "border-2 border-accent" : "border border-border",
        )}
      />
      {onSearch && value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue("");
            navigate("/search");
            ref.current?.focus();
          }}
          className="absolute top-1/2 right-0.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-fg-2 hover:bg-border"
        >
          <Icon name="X" size={18} />
        </button>
      )}
    </form>
  );
}

function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 flex h-[calc(4rem+env(safe-area-inset-bottom))] border-t border-border bg-surface pb-safe md:hidden"
    >
      {NAV.map(({ to, icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            clsx(
              "tap flex flex-1 flex-col items-center justify-center gap-1 text-2xs no-underline",
              isActive ? "font-bold text-fg" : "font-medium text-fg-2",
            )
          }
        >
          <Icon name={icon} size={24} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** ≥768px: 56px top bar inside the main pane. When the sidebar is collapsed
 * the logo moves here, immediately right of the rail at full size, before the
 * search pill. <768px: phone header with the logo, Search and the avatar. */
function TopBar({ collapsed }: { collapsed: boolean }) {
  return (
    <header
      className={clsx(
        "hidden h-14 shrink-0 items-center gap-4 px-10 md:flex",
        collapsed && "pl-28",
      )}
    >
      <TopBarSearch />
      <div className="ml-auto shrink-0">
        <AccountMenu />
      </div>
    </header>
  );
}

function PhoneHeader() {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between bg-bg/95 px-2 pt-safe backdrop-blur md:hidden">
      <Logo size={24} textClass="text-[19px]" />
      <div className="flex shrink-0 items-center gap-1">
        <Link
          to="/search"
          aria-label="Search"
          className="tap grid size-11 place-items-center rounded-full text-fg no-underline hover:bg-raised"
        >
          <Icon name="Search" size={24} />
        </Link>
        <AccountMenu size={32} />
      </div>
    </header>
  );
}

/** Direction D shell: labelled sidebar (desktop/tablet) or phone header +
 * bottom nav, a glowing main pane, and the player surfaces — the desktop
 * player bar or the phone mini player — whenever a book is loaded. */
function Shell() {
  const { user } = useAuth();
  const player = usePlayer();
  useEvents();
  const location = useLocation();
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  const phone = !useMediaQuery("(min-width: 768px)");
  const onPlayerPage = location.pathname === "/player";
  // The book page glows with its own cover colour; the query shares the cache
  // with the page itself, so this costs no extra request.
  const bookGlowId = /^\/books\/([^/?]+)/.exec(location.pathname)?.[1];
  const bookGlowQuery = useBook(bookGlowId ?? "");

  // Handoff "When the player shows": load the most recently played book,
  // paused, once per app start, so Resume is one click from any page.
  const { data: continueData } = useContinueListening(4);
  const p = useRef(player);
  p.current = player;
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

  // Space toggles play, arrows seek — whenever a book is loaded.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!p.current.book) return;
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === "Space") {
        event.preventDefault(); // Space on a focused button would also click it
        p.current.toggle();
      } else if (event.key === "ArrowRight") {
        p.current.skipForward();
      } else if (event.key === "ArrowLeft") {
        p.current.skipBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!user) return null; // RequireAuth guarantees a user before this renders.

  const glow = onPlayerPage
    ? coverGlow(player.book)
    : bookGlowId
      ? coverGlow(bookGlowQuery.data?.book, false)
      : { className: "bg-page-glow" as const };
  return (
    <div className={clsx("relative flex min-h-dvh", glow.className)} style={glow.style}>
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} inProgress={continueData?.items ?? []} />
      {/* Fixed at the same coordinates in both modes: the rail narrows around it. */}
      <div className="absolute left-[60px] top-0 z-30 hidden h-14 items-center md:flex">
        <Logo size={29} textClass="text-[23px]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar collapsed={collapsed} />
        <PhoneHeader />
        <main
          className={clsx(
            "min-w-0 px-4 lg:px-10",
            onPlayerPage
              ? // The player owns the viewport: top bar + this box = 100dvh, so
                // the document never scrolls and only the panels do.
                "h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden pb-[calc(72px+env(safe-area-inset-bottom))] lg:pb-[72px]"
              : clsx(
                  "flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-12",
                  player.book && "pb-[calc(10rem+env(safe-area-inset-bottom))] lg:pb-[calc(72px+3rem)]",
                ),
          )}
        >
          <Outlet />
        </main>
      </div>

      <BottomNav />

      {player.book && !onPlayerPage && player.resumePrompt && (
        <div className="fixed inset-x-0 bottom-[calc(8.5rem+env(safe-area-inset-bottom))] z-40 mx-auto w-full max-w-md px-4 lg:bottom-[calc(72px+1rem)]">
          <ResumePrompt {...player.resumePrompt} />
        </div>
      )}
      {player.book && (phone ? !onPlayerPage && <MiniPlayer /> : <PlayerBar />)}
    </div>
  );
}
