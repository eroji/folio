import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { AuthProvider } from "../auth/AuthProvider";
import { LibraryPage } from "../pages/LibraryPage";
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

/** Wait until AuthProvider's /auth/me resolves and the shell renders. */
async function boot(): Promise<void> {
  await screen.findByRole("link", { name: "Folio home" });
}

/** The rail nav and the phone tab bar share the reference's "Main" label;
 * the rail comes first in the DOM. */
function navs(): HTMLElement[] {
  return screen.getAllByRole("navigation", { name: "Main" });
}

async function openRailMenu(): Promise<HTMLElement> {
  await boot();
  const trigger = screen.getAllByRole("button", { name: "Account menu" })[0];
  fireEvent.click(trigger!);
  return screen.findByRole("menu", { name: "Account" });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("marks the active route in the rail with aria-current", async () => {
    renderShell({ entry: "/upload" });
    await boot();
    const rail = navs()[0]!;
    expect(within(rail).getByRole("link", { name: "Upload" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(rail).getByRole("link", { name: "Library" }).getAttribute("aria-current")).toBeNull();
  });

  it("renders the phone tab bar with Library, Search, Upload and You", async () => {
    renderShell();
    await boot();
    const tabs = navs()[1]!;
    expect(within(tabs).getByRole("link", { name: "Library" })).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: "Search" }).getAttribute("href")).toBe(
      "/?focus=search",
    );
    expect(within(tabs).getByRole("link", { name: "Upload" })).toBeTruthy();
    expect(within(tabs).getByRole("button", { name: /You/ })).toBeTruthy();
  });

  it("opens the account menu with ArrowDown and closes it with Escape, restoring focus", async () => {
    renderShell();
    await boot();
    const trigger = screen.getAllByRole("button", { name: "Account menu" })[0]!;
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Account" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows Admin only for admins", async () => {
    renderShell({ role: "admin" });
    const menu = await openRailMenu();
    expect(within(menu).getByRole("menuitem", { name: "Admin" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeTruthy();
  });

  it("hides Admin for plain users", async () => {
    renderShell({ role: "user" });
    const menu = await openRailMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Admin" })).toBeNull();
  });

  it("switches and persists the theme from the inline radiogroup in one click", async () => {
    renderShell();
    const menu = await openRailMenu();
    const dark = within(menu).getByRole("menuitemradio", { name: "Dark" });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(localStorage.getItem("folio-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("signs out from the menu and lands on the login page", async () => {
    renderShell();
    const menu = await openRailMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    await screen.findByText("Sign in");
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/auth/logout")),
    ).toBe(true);
  });

  it("navigates to /?focus=search and focuses the library search field", async () => {
    renderShell({ outlet: <LibraryPage /> });
    await boot();
    fireEvent.click(within(navs()[0]!).getByRole("link", { name: "Search" }));
    const input = await screen.findByRole("searchbox", { name: "Search books" });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('focuses search on "/" but not while typing in a field', async () => {
    renderShell({ outlet: <LibraryPage /> });
    await boot();
    await screen.findByRole("searchbox", { name: "Search books" });
    fireEvent.keyDown(document.body, { key: "/" });
    const input = screen.getByRole("searchbox", { name: "Search books" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    const sort = screen.getByRole("combobox", { name: "Sort by" });
    sort.focus();
    fireEvent.keyDown(sort, { key: "/" });
    expect(document.activeElement).toBe(sort);
  });

  it("loads the most recent book paused on start so Resume is one click away", async () => {
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    const panel = await screen.findByRole("complementary", { name: "Now playing" });
    expect(within(panel).getByRole("button", { name: "Play" })).toBeTruthy(); // paused, not playing
  });

  it("shows no player surfaces without listening history", async () => {
    renderShell();
    await boot();
    expect(screen.queryByRole("complementary", { name: "Now playing" })).toBeNull();
  });

  it('collapses with "p", opens focus mode with "f" on desktop and returns on Escape', async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true, // desktop, and contents open by default
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    await screen.findByRole("complementary", { name: "Now playing" });
    fireEvent.keyDown(document.body, { key: "p" });
    await waitFor(() => expect(localStorage.getItem("folio-player-collapsed")).toBe("true"));
    fireEvent.keyDown(document.body, { key: "p" });
    await waitFor(() => expect(localStorage.getItem("folio-player-collapsed")).toBe("false"));
    fireEvent.keyDown(document.body, { key: "f" });
    await screen.findByRole("button", { name: "Exit focus mode" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Exit focus mode" })).toBeNull());
    // The overlay is state, not a route: the page and panel are exactly as left.
    expect(screen.getByRole("complementary", { name: "Now playing" })).toBeTruthy();
  });

  it("does not open focus mode with f below the desktop breakpoint", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    renderShell({ continueItems: [{ book: makeBook(), progress: makeProgress({}) }] });
    await boot();
    await screen.findByRole("complementary", { name: "Now playing" });
    fireEvent.keyDown(document.body, { key: "f" });
    expect(screen.queryByRole("button", { name: "Exit focus mode" })).toBeNull();
  });
});
