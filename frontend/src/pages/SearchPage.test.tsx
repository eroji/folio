import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";
import type { Book } from "../api/types";

const TIME_MACHINE: Book = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "The Time Machine",
  subtitle: null,
  authors: ["H. G. Wells"],
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
  est_duration_s: 12720,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function makeBook(overrides: Partial<Book>): Book {
  return { ...TIME_MACHINE, id: "33333333-3333-3333-3333-333333333333", ...overrides };
}

function mockList(items: Book[], continueItems: unknown[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown;
      if (url.pathname.includes("/me/continue")) body = { items: continueItems };
      else if (url.pathname.includes("/me/finished")) body = { items: [] };
      else {
        const q = url.searchParams.get("q");
        const matched = q
          ? items.filter((book) =>
              [book.title, book.authors.join(" "), book.series ?? ""]
                .join(" ")
                .toLowerCase()
                .includes(q.toLowerCase()),
            )
          : items;
        body = { items: matched, total: matched.length, page: 1, page_size: 24 };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderSearch(entry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearchPage", () => {
  it("groups results with a count line, marks matches and links authors to /search", async () => {
    mockList(
      [
        makeBook({ id: TIME_MACHINE.id, title: "The Time Machine" }),
        makeBook({ id: "44444444-4444-4444-4444-444444444444", title: "The War of the Worlds" }),
      ],
      [{ book: TIME_MACHINE, progress: { chapter_id: "c1", segment_id: "s1", offset_s: 1, percent: 40, device_label: "d", updated_at: "2026-01-02T00:00:00Z", finished_at: null } }],
    );
    renderSearch("/?q=wells");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("2 results for “wells” in titles, authors and series");

    const authors = await screen.findByRole("region", { name: "Authors" });
    const authorLink = within(authors).getByRole("link", { name: /Wells/ });
    expect(authorLink.getAttribute("href")).toBe("/search?q=H.%20G.%20Wells");
    expect(within(authorLink).getByText("2 books")).toBeTruthy();
    expect(authorLink.querySelector("mark")?.textContent).toBe("Wells");

    const books = await screen.findByRole("region", { name: "Books" });
    const row = within(books).getByRole("link", { name: /The Time Machine/ });
    expect(within(row).getByText("2 h 7 m left")).toBeTruthy(); // 12 720 s × 60 %
    expect(row.querySelector("mark")?.textContent).toBe("Wells");
  });

  it("shows the no-match state with an upload link", async () => {
    mockList([TIME_MACHINE]);
    renderSearch("/?q=zzz");
    expect(await screen.findByRole("heading", { name: "No books match “zzz”" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload a book" })).toBeTruthy();
  });

  it("asks for a query when ?q= is empty", async () => {
    mockList([TIME_MACHINE]);
    renderSearch("/search");
    expect(await screen.findByText(/Type in the search field/)).toBeTruthy();
  });
});
