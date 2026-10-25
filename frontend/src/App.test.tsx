import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { DEFAULT_SETTINGS } from "./api/settings";
import { installMockEventSource } from "./test/eventsource";

const DUNE_ID = "11111111-1111-1111-1111-111111111111";

function makeBook(overrides: Record<string, unknown> = {}) {
  return {
    id: DUNE_ID,
    title: "Dune",
    subtitle: null,
    authors: ["Frank Herbert"],
    series: null,
    series_index: null,
    description: null,
    publisher: null,
    published_date: null,
    language: "en",
    isbn10: null,
    isbn13: null,
    tags: [],
    narrator_voice: null,
    cover_url: null,
    status: "ready",
    error: null,
    total_chars: 1000,
    est_duration_s: 600,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown;
      if (url.pathname.includes("/auth/me")) {
        body = {
          user: { id: "u1", username: "browser", display_name: "Browser User", email: null, role: "user" },
          csrf_token: "t",
        };
      } else if (url.pathname.includes("/me/continue") || url.pathname.includes("/me/finished")) {
        body = { items: [] };
      } else if (url.pathname.includes("/me/home")) {
        body = { continue: [], next_chapters: [], recent: [makeBook()] };
      } else if (url.pathname.includes("/me/settings")) {
        body = { settings: DEFAULT_SETTINGS };
      } else if (url.pathname.includes("/search")) {
        body = { top: null, books: [], authors: [], series: [] };
      } else if (url.pathname.includes("/books")) {
        const q = url.searchParams.get("q");
        const matched = q ? [] : [makeBook()];
        body = url.searchParams.get("group")
          ? { groups: [{ key: "Science fiction", label: "Science fiction", count: matched.length, books: matched }] }
          : { items: matched, total: matched.length, page: 1, page_size: 24 };
      } else {
        body = {};
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderApp(entry: string): void {
  mockFetch();
  installMockEventSource();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routes", () => {
  it('renders Home shelves at "/"', async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Recently added" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: /Dune/ })).toBeTruthy();
  });

  it('renders the grouped library at "/library"', async () => {
    renderApp("/library");
    await screen.findByRole("heading", { name: "Library" });
    expect(await screen.findByRole("region", { name: "Science fiction" })).toBeTruthy();
  });

  it('redirects "/library?q=…" to "/search?q=…"', async () => {
    renderApp("/library?q=wells");
    // The Search page answers with its result count; the library grid never shows.
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Library" })).toBeNull();
  });

  it("renders the search page at /search?q=", async () => {
    renderApp("/search?q=wells");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("results for “wells”");
  });
});
