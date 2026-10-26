import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "./LibraryPage";
import { AuthProvider } from "../auth/AuthProvider";
import type { Book, Progress } from "../api/types";

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Dune",
    subtitle: null,
    authors: ["Frank Herbert"],
    series: "Dune",
    series_index: 1,
    description: null,
    publisher: null,
    published_date: null,
    language: "en",
    isbn10: null,
    isbn13: null,
    tags: [],
    genre: "Science fiction",
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

function makeProgress(overrides: Partial<Progress> = {}): Progress {
  return {
    chapter_id: "c1",
    segment_id: "s1",
    offset_s: 60,
    percent: 25,
    device_label: "Linux a1b2",
    updated_at: "2026-01-02T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

interface MockOptions {
  continueItems?: unknown[];
  finishedItems?: unknown[];
}

/** Mirrors GET /books: grouped listings bucket by group (first 12 per group,
 * "No genre yet" last), flat listings honour genre and paging. */
function mockApi(books: Book[], options: MockOptions = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown = {};
      if (url.pathname.includes("/auth/me")) {
        body = {
          user: { id: "u1", username: "browser", display_name: "Browser User", email: null, role: "user" },
          csrf_token: "t",
        };
      } else if (url.pathname.includes("/me/continue")) {
        body = { items: options.continueItems ?? [] };
      } else if (url.pathname.includes("/me/finished")) {
        body = { items: options.finishedItems ?? [] };
      } else if (url.pathname.endsWith("/books")) {
        const group = url.searchParams.get("group");
        const genre = url.searchParams.get("genre");
        let items = books;
        if (genre) {
          items = items.filter((book) =>
            genre === "none" ? !book.genre : book.genre === genre,
          );
        }
        if (group && group !== "none") {
          const buckets = new Map<string | null, Book[]>();
          for (const book of items) {
            const key =
              group === "genre"
                ? (book.genre ?? null)
                : group === "language"
                  ? book.language
                  : group === "status"
                    ? book.status
                    : (book.authors[0] ?? null);
            buckets.set(key, [...(buckets.get(key) ?? []), book]);
          }
          body = {
            groups: [...buckets.entries()].map(([key, list]) => ({
              key,
              label: group === "genre" ? (key ?? "No genre yet") : String(key),
              count: list.length,
              books: list.slice(0, 12),
            })),
          };
        } else {
          body = { items, total: items.length, page: 1, page_size: 24 };
        }
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderLibrary(initialEntry = "/library") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <LibraryPage />
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

describe("LibraryPage", () => {
  it("groups by Genre by default with shelves sorted by count and No genre yet last", async () => {
    mockApi([
      makeBook(),
      makeBook({ id: "22222222-2222-2222-2222-222222222222", title: "Neuromancer" }),
      makeBook({
        id: "33333333-3333-3333-3333-333333333333",
        title: "Moby-Dick",
        genre: "Classics",
      }),
      makeBook({
        id: "44444444-4444-4444-4444-444444444444",
        title: "Untitled Ledger",
        genre: null,
      }),
    ]);
    renderLibrary();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    await screen.findByRole("heading", { name: "Library" });

    await waitFor(() => {
      const shelves = [
        screen.getByRole("region", { name: "Science fiction" }),
        screen.getByRole("region", { name: "Classics" }),
        screen.getByRole("region", { name: "No genre yet" }),
      ];
      // count desc, "No genre yet" last:
      const sections = [...document.querySelectorAll("section[aria-label]")];
      expect(sections.indexOf(shelves[0]!)).toBeLessThan(sections.indexOf(shelves[1]!));
      expect(sections.indexOf(shelves[1]!)).toBeLessThan(sections.indexOf(shelves[2]!));
    });
    expect(
      within(screen.getByRole("region", { name: "Science fiction" })).getByText("2"),
    ).toBeTruthy();
    const seeAll = screen.getAllByRole("link", { name: "See all" });
    expect(seeAll[0]?.getAttribute("href")).toContain("/library?group=none&genre=");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the empty state when there are no books", async () => {
    mockApi([]);
    renderLibrary();
    expect(
      await screen.findByRole("heading", { name: "Your library is empty" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload books" })).toBeTruthy();
  });

  it("shows chip counts including Needs attention", async () => {
    mockApi(
      [
        makeBook(),
        makeBook({
          id: "22222222-2222-2222-2222-222222222222",
          title: "Neuromancer",
          genre: "Science fiction",
        }),
        makeBook({
          id: "33333333-3333-3333-3333-333333333333",
          title: "Scanned Ledger",
          genre: null,
          status: "needs_ocr",
        }),
        makeBook({
          id: "44444444-4444-4444-4444-444444444444",
          title: "Frankenstein",
          genre: "Classics",
        }),
      ],
      {
        continueItems: [{ book: makeBook(), progress: makeProgress() }],
        finishedItems: [
          {
            book: makeBook({ id: "44444444-4444-4444-4444-444444444444" }),
            progress: makeProgress({ percent: 100, finished_at: "2026-01-03T00:00:00Z" }),
          },
        ],
      },
    );
    renderLibrary();
    const group = await screen.findByRole("group", { name: "Filter" });
    expect(await within(group).findByRole("button", { name: "All 4" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "In progress 1" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Not started 2" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Finished 1" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Needs attention 1" })).toBeTruthy();
    expect(
      within(group)
        .getByRole("button", { name: "All 4" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("filters inside groups when a status chip is chosen", async () => {
    mockApi(
      [
        makeBook(),
        makeBook({ id: "22222222-2222-2222-2222-222222222222", title: "Neuromancer" }),
      ],
      { continueItems: [{ book: makeBook(), progress: makeProgress() }] },
    );
    renderLibrary();
    const group = await screen.findByRole("group", { name: "Filter" });
    fireEvent.click(within(group).getByRole("button", { name: /In progress/ }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Neuromancer/ })).toBeNull(),
    );
    expect(screen.getAllByRole("link", { name: /Dune/ }).length).toBeGreaterThan(0);
  });

  it("remembers group, sort and view per user and restores them", async () => {
    mockApi([makeBook()]);
    const view = renderLibrary();
    await screen.findByRole("heading", { name: "Library" });
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), {
      target: { value: "author" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), {
      target: { value: "played" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "List view" }));
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("folio-library-u1") ?? "{}"),
      ).toEqual({ group: "author", sort: "played", view: "list" }),
    );

    // A fresh visit reads the stored preferences back: a flat list (list view
    // ignores grouping) sorted by the API's sort=progress.
    view.unmount();
    vi.mocked(fetch).mockClear();
    renderLibrary();
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("sort=progress"));
      expect(call).toBeTruthy();
    });
    expect(screen.getByRole("radio", { name: "List view" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("renders list rows with cover, author, length, progress and a book menu", async () => {
    mockApi([makeBook()], { continueItems: [{ book: makeBook(), progress: makeProgress() }] });
    renderLibrary("/library?group=none&view=list");
    const row = await screen.findByRole("listitem");
    expect(within(row).getAllByText("Frank Herbert").length).toBeGreaterThan(0);
    expect(within(row).getByText("10 m")).toBeTruthy();
    expect(within(row).getByText("8 m left")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "More options for Dune" }),
    ).toBeTruthy();
  });

  it("serves the flat genre listing from See-all links", async () => {
    mockApi([
      makeBook(),
      makeBook({
        id: "33333333-3333-3333-3333-333333333333",
        title: "Moby-Dick",
        genre: "Classics",
      }),
    ]);
    renderLibrary("/library?group=none&genre=Classics");
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("genre=Classics"));
      expect(call).toBeTruthy();
    });
    await screen.findByRole("link", { name: /Moby-Dick/ });
    expect(screen.queryByRole("link", { name: /Dune/ })).toBeNull();
  });

  it("shows a status line on cards only when the book is not ready", async () => {
    mockApi([
      makeBook({
        id: "22222222-2222-2222-2222-222222222222",
        title: "Neuromancer",
        status: "processing",
      }),
      makeBook({
        id: "33333333-3333-3333-3333-333333333333",
        title: "Scanned Ledger",
        genre: "Classics",
        status: "needs_ocr",
      }),
    ]);
    renderLibrary();
    expect(
      within(await screen.findByRole("link", { name: /Neuromancer/ })).getByText(
        "Processing…",
      ),
    ).toBeTruthy();
    expect(
      within(await screen.findByRole("link", { name: /Scanned Ledger/ })).getByText("Needs OCR"),
    ).toBeTruthy();
  });

  it("shows the percent overlay on started library covers and carries progress in the name", async () => {
    mockApi([makeBook()], { continueItems: [{ book: makeBook(), progress: makeProgress() }] });
    renderLibrary();
    const cards = await screen.findAllByRole("link", { name: /Dune.*25% listened/ });
    // The pill is aria-hidden: the name still comes from coverName.
    expect(cards.every((card) => within(card).queryByTestId("cover-percent") !== null)).toBe(true);
    expect(cards.every((card) => card.querySelector("[aria-hidden='true'] span[style*='width']") !== null)).toBe(true);
  });
});
