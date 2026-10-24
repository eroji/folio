import { render, screen, within } from "@testing-library/react";
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

function mockList(items: Book[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ items, total: items.length, page: 1, page_size: 24 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
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
});
