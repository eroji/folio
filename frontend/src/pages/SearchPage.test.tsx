import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";
import { PlayerProvider } from "../player/PlayerProvider";
import { installPlayerFetch, makeBook, makeProgress, stubMedia } from "../test/player";
import type { Book } from "../api/types";

function shelfBook(id: string, overrides: Partial<Book> = {}): Book {
  return {
    ...makeBook(),
    id,
    title: "The Time Machine",
    authors: ["H. G. Wells"],
    est_duration_s: 12720,
    ...overrides,
  };
}

const TIME_MACHINE = shelfBook("22222222-2222-2222-2222-222222222222");
const WAR_OF_THE_WORLDS = shelfBook("33333333-3333-3333-3333-333333333333", {
  title: "The War of the Worlds",
});
const INVISIBLE_MAN = shelfBook("44444444-4444-4444-4444-444444444444", {
  title: "The Invisible Man",
});

const ALL_RESULTS = {
  top: { type: "author", name: "H. G. Wells", count: 3, finished: 1 },
  books: [TIME_MACHINE, WAR_OF_THE_WORLDS, INVISIBLE_MAN],
  authors: [{ name: "H. G. Wells", count: 3 }],
  series: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** /search answers from `search`; continue/finished carry the given rows;
 * everything else goes to the player fixture. */
function mockSearch(
  search: Record<string, unknown> | ((url: URL) => unknown),
  continueItems: { book: Book; progress: ReturnType<typeof makeProgress> }[] = [
    { book: TIME_MACHINE, progress: makeProgress({ percent: 40 }) },
  ],
): void {
  installPlayerFetch();
  const base = vi.mocked(fetch);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.includes("/search"))
        return jsonResponse(typeof search === "function" ? search(url) : search);
      if (url.pathname.includes("/me/continue")) return jsonResponse({ items: continueItems });
      if (url.pathname.includes("/me/finished")) {
        return jsonResponse({
          items: continueItems.some((item) => item.progress.finished_at) ? continueItems : [],
        });
      }
      return base(input, init);
    }),
  );
}

function renderSearch(entry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <PlayerProvider>
          <SearchPage />
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Matches an element whose full text equals `text` (the meta line is split
 * by the <mark> of the highlighted query). */
function exactText(text: string) {
  return (_content: string, element: Element | null): boolean =>
    element?.tagName === "SPAN" && element.textContent === text;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SearchPage", () => {
  it("shows the count line, type chips, author top result and book rows", async () => {
    mockSearch(ALL_RESULTS, [
      { book: TIME_MACHINE, progress: makeProgress({ percent: 40 }) },
      { book: WAR_OF_THE_WORLDS, progress: makeProgress({ finished_at: "2026-01-03T00:00:00Z" }) },
    ]);
    renderSearch("/search?q=wells");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("4 results for “wells”");

    const chips = screen.getAllByRole("button", { name: /^(All|Books|Authors|Series)$/ });
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);

    const top = await screen.findByRole("region", { name: "Top result" });
    expect(within(top).getByText("H. G. Wells")).toBeTruthy();
    expect(within(top).getByText("Author · 3 books · 1 finished")).toBeTruthy();
    expect(within(top).getByRole("button", { name: "Play" })).toBeTruthy();
    expect(within(top).getByRole("link", { name: "View books" }).getAttribute("href")).toBe(
      "/search?q=H.%20G.%20Wells&type=books",
    );

    const books = await screen.findByRole("region", { name: "Books" });
    const row = within(books).getByRole("link", { name: /The Time Machine/ });
    expect(within(row).getByText(exactText("Book · H. G. Wells · 2 h 7 m left"))).toBeTruthy();
    expect(row.querySelector("mark")?.textContent).toBe("Wells");
    expect(
      within(books).getByRole("button", { name: "More options for The Time Machine" }),
    ).toBeTruthy();
    // Finished books answer with a check instead of a length.
    const finished = within(books).getByRole("link", { name: /The War of the Worlds/ });
    expect(within(finished).getByText(exactText("Book · H. G. Wells · Finished"))).toBeTruthy();
    expect(within(books).getAllByTitle("Finished")).toHaveLength(1);
    expect(
      within(books).getByRole("button", { name: "More options for The War of the Worlds" }),
    ).toBeTruthy();
  });

  it("filters through ?type= when a chip is pressed", async () => {
    mockSearch((url) =>
      url.searchParams.get("type") === "books"
        ? { top: { type: "book", book: TIME_MACHINE }, books: [TIME_MACHINE], authors: [], series: [] }
        : ALL_RESULTS,
    );
    renderSearch("/search?q=wells");
    await screen.findByRole("region", { name: "Top result" });

    fireEvent.click(screen.getByRole("button", { name: "Books" }));

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input]) =>
              String(input).includes("/search") && new URL(String(input), "http://localhost").searchParams.get("type") === "books",
          ),
      ).toBe(true),
    );
    await screen.findByText("1 result for “wells”");

    // A book top result shows cover, meta and Resume + Open.
    const top = await screen.findByRole("region", { name: "Top result" });
    expect(within(top).getByText("Book · H. G. Wells · 3 h 32 m")).toBeTruthy();
    expect(within(top).getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(within(top).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `/books/${TIME_MACHINE.id}`,
    );
  });

  it("plays the author's most recent in-progress book from the top result", async () => {
    const { played } = stubMedia();
    mockSearch(ALL_RESULTS);
    renderSearch("/search?q=wells");
    const top = await screen.findByRole("region", { name: "Top result" });

    fireEvent.click(within(top).getByRole("button", { name: "Play" }));
    await vi.waitFor(() => expect(played.length).toBeGreaterThan(0));
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/books/${TIME_MACHINE.id}`)),
    ).toBe(true);
  });

  it("lists authors for the Authors chip and links to a search for their name", async () => {
    mockSearch(ALL_RESULTS);
    renderSearch("/search?q=wells&type=authors");
    const authors = await screen.findByRole("region", { name: "Authors" });
    const link = within(authors).getByRole("link", { name: /Wells/ });
    expect(link.getAttribute("href")).toBe("/search?q=H.%20G.%20Wells");
    expect(link.querySelector("mark")?.textContent).toBe("Wells");
    expect(within(link).getByText("3 books")).toBeTruthy();
  });

  it("shows the no-match state with an upload link", async () => {
    mockSearch({ top: null, books: [], authors: [], series: [] });
    renderSearch("/search?q=zzz");
    expect(await screen.findByRole("heading", { name: "No books match “zzz”" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload books" })).toBeTruthy();
  });

  it("asks for a query when ?q= is empty", async () => {
    mockSearch(ALL_RESULTS);
    renderSearch("/search");
    expect(await screen.findByText(/Type in the search field/)).toBeTruthy();
  });
});
