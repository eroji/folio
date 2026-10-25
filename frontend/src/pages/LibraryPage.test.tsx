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
import type { Book, Progress } from "../api/types";

const DUNE_ID = "11111111-1111-1111-1111-111111111111";

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: DUNE_ID,
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

/** /books?q= filters title/authors/series case-insensitively, like the API. */
function mockList(
  items: Book[],
  continueItems: unknown[] = [],
  finishedItems: unknown[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      let body: unknown;
      if (url.pathname.includes("/me/continue"))
        body = { items: continueItems };
      else if (url.pathname.includes("/me/finished"))
        body = { items: finishedItems };
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
        body = {
          items: matched,
          total: matched.length,
          page: 1,
          page_size: 24,
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderLibrary(initialEntries: string[] = ["/"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <LibraryPage />
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
  it("renders skeletons then cover cards, with a status line only when not ready", async () => {
    mockList([
      makeBook(),
      makeBook({
        id: "22222222-2222-2222-2222-222222222222",
        title: "Neuromancer",
        status: "processing",
      }),
      makeBook({
        id: "33333333-3333-3333-3333-333333333333",
        title: "Scanned Ledger",
        status: "needs_ocr",
      }),
      makeBook({
        id: "44444444-4444-4444-4444-444444444444",
        title: "Broken Book",
        status: "failed",
      }),
    ]);
    renderLibrary();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();

    const ready = await screen.findByRole("link", { name: /Dune/ });
    expect(ready.getAttribute("href")).toBe(`/books/${DUNE_ID}`);
    expect(
      within(ready).queryByText(/Processing|Needs OCR|Couldn.t process/),
    ).toBeNull();
    expect(
      within(screen.getByRole("link", { name: /Neuromancer/ })).getByText(
        "Processing…",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("link", { name: /Scanned Ledger/ })).getByText(
        "Needs OCR",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("link", { name: /Broken Book/ })).getByText(
        "Couldn't process",
      ),
    ).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the empty state with the spec copy", async () => {
    mockList([]);
    renderLibrary();
    expect(
      await screen.findByRole("heading", { name: "No books yet" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Upload your first EPUB, PDF or Kindle file."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload a book" })).toBeTruthy();
  });

  it("hides the Continue listening section when /me/continue is empty", async () => {
    mockList([makeBook()]);
    renderLibrary();
    await screen.findByRole("link", { name: /Dune/ });
    expect(
      screen.queryByRole("region", { name: "Continue listening" }),
    ).toBeNull();
  });

  it("shows Continue cards that resume the saved chapter, with time left", async () => {
    mockList([makeBook()], [{ book: makeBook(), progress: makeProgress() }]);
    renderLibrary();
    const section = await screen.findByRole("region", {
      name: "Continue listening",
    });
    expect(within(section).getByText("8 m left")).toBeTruthy(); // 600 s × 75 % ≈ 7.5 min
    const card = within(section).getByRole("link", {
      name: "Dune, 25% listened, resume",
    });
    expect(card.getAttribute("href")).toBe(
      `/player?book=${DUNE_ID}&chapter=c1`,
    );
  });

  it("shows at most four Continue listening cards", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      book: makeBook({
        id: `bbbbbbbb-0000-0000-0000-00000000000${i}`,
        title: `Book ${i}`,
      }),
      progress: makeProgress(),
    }));
    mockList([makeBook()], items);
    renderLibrary();
    const section = await screen.findByRole("region", {
      name: "Continue listening",
    });
    expect(within(section).getAllByRole("link")).toHaveLength(4);
  });

  it("carries progress in the card name, not a visible percent (D cover bar)", async () => {
    mockList([makeBook()], [{ book: makeBook(), progress: makeProgress() }]);
    renderLibrary();
    const cards = await screen.findAllByRole("link", {
      name: /Dune.*25% listened/,
    });
    // Direction D replaced the percent badge with a bar on the cover: no
    // visible "25%" text anywhere; the state lives in the accessible name.
    expect(cards.every((card) => within(card).queryByText("25%") === null)).toBe(true);
  });

  it("names a finished card and hides the badge percent", async () => {
    mockList(
      [makeBook()],
      [],
      [
        {
          book: makeBook(),
          progress: makeProgress({
            percent: 100,
            finished_at: "2026-01-03T00:00:00Z",
          }),
        },
      ],
    );
    renderLibrary();
    const card = await screen.findByRole("link", { name: /Dune.*finished/ });
    expect(within(card).queryByText("100%")).toBeNull();
  });

  it("filters the grid with the progress chips and shows counts", async () => {
    mockList(
      [
        makeBook(),
        makeBook({
          id: "22222222-2222-2222-2222-222222222222",
          title: "Neuromancer",
        }),
      ],
      [{ book: makeBook(), progress: makeProgress() }],
    );
    renderLibrary();
    const group = await screen.findByRole("group", { name: "Filter books" });
    expect(
      await within(group).findByRole("button", { name: "All 2" }),
    ).toBeTruthy();
    expect(
      within(group).getByRole("button", { name: "In progress 1" }),
    ).toBeTruthy();
    expect(
      within(group).getByRole("button", { name: "Not started 1" }),
    ).toBeTruthy();
    expect(
      within(group).getByRole("button", { name: "Finished 0" }),
    ).toBeTruthy();
    expect(
      within(group)
        .getByRole("button", { name: "All 2" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      within(group).getByRole("button", { name: "In progress 1" }),
    );
    expect(
      within(group)
        .getByRole("button", { name: "In progress 1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Neuromancer/ })).toBeNull(),
    );
    expect(
      screen.getAllByRole("link", { name: /Dune.*25% listened/ }).length,
    ).toBeGreaterThan(0);
  });

  it("refetches with sort=progress when Progress is chosen", async () => {
    mockList([makeBook()]);
    renderLibrary();
    await screen.findByRole("link", { name: /Dune/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), {
      target: { value: "progress" },
    });
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("sort=progress"));
      expect(call).toBeTruthy();
    });
  });
});
