import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { AuthProvider } from "../auth/AuthProvider";
import { DEFAULT_SETTINGS } from "../api/settings";
import type { ContinueItem } from "../api/progress";
import { installMockEventSource } from "../test/eventsource";
import { installPlayerFetch, makeBook, makeProgress } from "../test/player";
import type { Role } from "../api/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(role: Role, continueItems: ContinueItem[] = []): void {
  if (continueItems.length > 0) installPlayerFetch();
  const playerFetch = continueItems.length > 0 ? vi.mocked(fetch) : null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return jsonResponse({
          user: { id: "u1", username: "browser", display_name: "Browser User", email: null, role },
        });
      }
      if (url.includes("/me/continue")) return jsonResponse({ items: continueItems });
      if (url.includes("/me/finished")) return jsonResponse({ items: [] });
      if (url.includes("/me/settings")) return jsonResponse({ settings: DEFAULT_SETTINGS });
      // Book detail, segments, prepare and progress go to the player fixture.
      if (playerFetch && (/\/books\/[^/?]+/.test(url) || url.includes("/audio/"))) {
        return playerFetch(input, init);
      }
      if (url.includes("/books")) return jsonResponse({ items: [], total: 0, page: 1, page_size: 24 });
      return jsonResponse({});
    }),
  );
}

/** Renders the current location so navigation can be asserted. */
function Probe() {
  const location = useLocation();
  return <p>{`${location.pathname}${location.search}`}</p>;
}

function renderShell(
  {
    role = "user",
    entry = "/",
    outlet = <div />,
    continueItems = [],
  }: { role?: Role; entry?: string; outlet?: React.ReactNode; continueItems?: ContinueItem[] } = {},
): void {
  mockFetch(role, continueItems);
  installMockEventSource();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={outlet} />
            </Route>
            <Route path="/login" element={<p>Sign in</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Wait until AuthProvider's /auth/me resolves and the shell renders.
 * The logo link exists twice (sidebar + phone header); both render in jsdom. */
async function boot(): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole("link", { name: "Folio home" }).length).toBeGreaterThan(0));
}

/** The sidebar and the phone bottom nav share the reference's "Main" label;
 * the sidebar comes first in the DOM. */
function navs(): HTMLElement[] {
  return screen.getAllByRole("navigation", { name: "Main" });
}

async function openAccountMenu(): Promise<HTMLElement> {
  await boot();
  const trigger = screen.getAllByRole("button", { name: "Account menu" })[0]!;
  fireEvent.click(trigger);
  return screen.findByRole("menu", { name: "Account" });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("marks the active route in the sidebar with aria-current", async () => {
    renderShell({ entry: "/library" });
    await boot();
    const sidebar = navs()[0]!;
    expect(within(sidebar).getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe("page");
    expect(within(sidebar).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("links Home, Library, Search and Upload in the sidebar", async () => {
    renderShell();
    await boot();
    const sidebar = navs()[0]!;
    const hrefs = {
      Home: "/",
      Library: "/library",
      Search: "/search",
      Upload: "/upload",
    };
    for (const [name, href] of Object.entries(hrefs)) {
      expect(within(sidebar).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
  });

  it("collapses the sidebar and remembers it in localStorage", async () => {
    renderShell();
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    await waitFor(() => expect(localStorage.getItem("folio-sidebar-collapsed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add books" })).toBeNull();
  });

  it("starts collapsed when localStorage remembers the rail", async () => {
    localStorage.setItem("folio-sidebar-collapsed", "true");
    renderShell();
    await boot();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(within(navs()[0]!).getByRole("link", { name: "Library" })).toBeTruthy();
  });

  it("links Add books to Upload and lists in-progress books from /me/continue", async () => {
    const book = makeBook();
    renderShell({ continueItems: [{ book, progress: makeProgress({ percent: 38 }) }] });
    await boot();
    const sidebar = navs()[0]!;
    expect(within(sidebar).getByRole("link", { name: "Add books" }).getAttribute("href")).toBe("/upload");
    const item = within(sidebar).getByRole("link", { name: /Dune/ });
    expect(item.getAttribute("href")).toBe(`/books/${book.id}`);
    expect(within(item).getByText("38%")).toBeTruthy();
  });

  it("shows an empty in-progress list when there is no history", async () => {
    renderShell();
    await boot();
    const sidebar = navs()[0]!;
    expect(within(sidebar).getByText("In progress")).toBeTruthy();
    expect(within(sidebar).getByText("Nothing in progress.")).toBeTruthy();
  });

  it("opens the account menu with ArrowDown and closes it with Escape, restoring focus", async () => {
    renderShell();
    await boot();
    const trigger = screen.getAllByRole("button", { name: "Account menu" })[0]!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Account" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the identity header with @username and Admin for admins", async () => {
    renderShell({ role: "admin" });
    const menu = await openAccountMenu();
    expect(within(menu).getByText("Browser User")).toBeTruthy();
    expect(within(menu).getByText("@browser · Admin")).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Admin" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  });

  it("hides Admin for plain users", async () => {
    renderShell({ role: "user" });
    const menu = await openAccountMenu();
    expect(within(menu).getByText("@browser")).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Admin" })).toBeNull();
  });

  it("signs out from the menu and lands on the login page", async () => {
    renderShell();
    const menu = await openAccountMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    await screen.findByText("Sign in");
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/auth/logout")),
    ).toBe(true);
  });

  it("navigates to /search?q= when the top bar search is submitted", async () => {
    renderShell({ outlet: <Probe /> });
    await boot();
    const input = await screen.findByRole("searchbox", { name: "Search books, authors, series" });
    fireEvent.change(input, { target: { value: "wells" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("/search?q=wells");
  });

  it('focuses the top bar search on "/" but not while typing in a field', async () => {
    renderShell();
    await boot();
    const input = await screen.findByRole("searchbox", { name: "Search books, authors, series" });
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false); // prevented, focus moves
    expect(document.activeElement).toBe(input);

    // While typing in the field, "/" is a character, not a shortcut.
    expect(fireEvent.keyDown(input, { key: "/" })).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("renders the phone header and bottom nav with Home, Library, Search and Upload", async () => {
    renderShell({ entry: "/library" });
    await boot();
    const tabs = navs()[1]!;
    for (const [name, href] of Object.entries({ Home: "/", Library: "/library", Search: "/search", Upload: "/upload" })) {
      expect(within(tabs).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
    expect(within(tabs).getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBe("page");

    const phoneHeader = screen.getAllByRole("banner")[1]!;
    expect(within(phoneHeader).getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/search");
    expect(within(phoneHeader).getByRole("button", { name: "Account menu" })).toBeTruthy();
  });

  it("loads the most recent book paused on start so Resume is one click away", async () => {
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    const bar = await screen.findByRole("region", { name: "Now playing" });
    expect(within(bar).getByRole("button", { name: "Play" })).toBeTruthy(); // paused, not playing
  });

  it("shows no player surfaces without listening history", async () => {
    renderShell();
    await boot();
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("renders the player bar and no phone mini player on desktop", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true, // desktop: player bar, no mini player
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    const bar = await screen.findByRole("region", { name: "Now playing" });
    expect(within(bar).getByRole("button", { name: "Stop and close player" })).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Open player" })).toBeTruthy();
  });

  it("renders the phone mini player below 768px", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, // phone: no sidebar, mini player instead of the bar
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    const mini = await screen.findByRole("region", { name: "Now playing" });
    expect(within(mini).getByRole("link", { name: /Open player/ })).toBeTruthy();
    expect(within(mini).queryByRole("button", { name: "Stop and close player" })).toBeNull();
  });
});
