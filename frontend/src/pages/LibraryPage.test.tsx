import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryPage } from "./LibraryPage";
import type { Book } from "../api/types";

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

function mockList(items: Book[], continueItems: unknown[] = [], finishedItems: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/me/continue")
        ? { items: continueItems }
        : url.includes("/me/finished")
          ? { items: finishedItems }
          : { items, total: items.length, page: 1, page_size: 24 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
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
  it("renders skeletons then cover cards", async () => {
    mockList([makeBook(), makeBook({ id: "22222222-2222-2222-2222-222222222222", title: "Neuromancer", status: "processing" })]);
    renderLibrary();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();

    // The gradient placeholder repeats the title, so match on the card link.
    const card = await screen.findByRole("link", { name: /Dune/ });
    expect(card.getAttribute("href")).toBe("/books/11111111-1111-1111-1111-111111111111");
    const other = screen.getByRole("link", { name: /Neuromancer/ });
    // "Ready"/"Processing" also appear as filter options, so scope to the cards.
    expect(within(card).getByText("Ready")).toBeTruthy();
    expect(within(other).getByText("Processing")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the empty state with the spec copy", async () => {
    mockList([]);
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "No books yet" })).toBeTruthy();
    expect(screen.getByText("Upload your first EPUB, PDF or Kindle file.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload a book" })).toBeTruthy();
  });

  it("hides the Continue listening row when /me/continue is empty", async () => {
    mockList([makeBook()]);
    renderLibrary();
    await screen.findByRole("link", { name: /Dune/ });
    expect(screen.queryByRole("region", { name: "Continue listening" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Continue listening" })).toBeNull();
  });

  it("shows a Continue listening card with a progress bar and time left", async () => {
    mockList([makeBook()], [
      {
        book: makeBook(),
        progress: {
          chapter_id: "c1",
          segment_id: "s1",
          offset_s: 60,
          percent: 25,
          device_label: "Linux a1b2",
          updated_at: "2026-01-02T00:00:00Z",
          finished_at: null,
        },
      },
    ]);
    renderLibrary();
    const row = await screen.findByRole("region", { name: "Continue listening" });
    expect(within(row).getByText("8m left")).toBeTruthy(); // 600 s × 75 % ≈ 7.5 min
    const card = within(row).getByRole("link", { name: /Dune/ });
    expect(card.getAttribute("href")).toBe(`/books/${makeBook().id}`);
  });

  it("badges a finished book in the Continue row instead of time left", async () => {
    mockList([makeBook()], [
      {
        book: makeBook(),
        progress: {
          chapter_id: "c1",
          segment_id: "s1",
          offset_s: 0,
          percent: 100,
          device_label: "Linux a1b2",
          updated_at: "2026-01-02T00:00:00Z",
          finished_at: "2026-01-03T00:00:00Z",
        },
      },
    ]);
    renderLibrary();
    const row = await screen.findByRole("region", { name: "Continue listening" });
    expect(within(row).getByText("Finished")).toBeTruthy();
  });

  it("shows a collapsible Finished section from /me/finished", async () => {
    mockList([makeBook()], [], [
      {
        book: makeBook({ id: "33333333-3333-3333-3333-333333333333", title: "Snow Crash" }),
        progress: {
          chapter_id: "c1",
          segment_id: "s1",
          offset_s: 0,
          percent: 100,
          device_label: "Linux a1b2",
          updated_at: "2026-01-02T00:00:00Z",
          finished_at: "2026-01-03T00:00:00Z",
        },
      },
    ]);
    renderLibrary();
    const section = await screen.findByRole("region", { name: "Finished" });
    expect(within(section).getByText("Finished (1)")).toBeTruthy();
    expect(within(section).getByRole("link", { name: /Snow Crash/ })).toBeTruthy();
  });

  it("hides the Finished section when /me/finished is empty", async () => {
    mockList([makeBook()]);
    renderLibrary();
    await screen.findByRole("link", { name: /Dune/ });
    expect(screen.queryByRole("region", { name: "Finished" })).toBeNull();
  });

  it("refetches with sort=progress when Progress is chosen", async () => {
    mockList([makeBook()]);
    renderLibrary();
    await screen.findByRole("link", { name: /Dune/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "progress" } });
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("sort=progress"));
      expect(call).toBeTruthy();
    });
  });
});
