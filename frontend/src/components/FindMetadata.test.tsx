import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindMetadata } from "./FindMetadata";
import type { Book, Candidate } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";

function makeBook(): Book {
  return {
    id: ID,
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
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    source: "openlibrary",
    title: "Dune",
    authors: ["Frank Herbert"],
    published_date: "1965",
    publisher: "Chilton",
    description: "A science-fiction classic.",
    language: "en",
    isbn10: null,
    isbn13: "9780441013593",
    series: null,
    series_index: null,
    tags: [],
    cover_url: "https://covers.test/dune.jpg",
    score: 0.93,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let searchItems: Candidate[] = [];
let searchStatus = 200;
let applies: Record<string, unknown>[] = [];

function renderFind(client: QueryClient, initialItems?: Candidate[]) {
  render(
    <QueryClientProvider client={client}>
      <FindMetadata book={makeBook()} initialItems={initialItems} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  searchItems = [makeCandidate(), makeCandidate({ source: "googlebooks", title: "Dune Chronicles" })];
  searchStatus = 200;
  applies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/metadata/search")) {
        if (searchStatus !== 200) {
          return jsonResponse(searchStatus, { error: { code: "provider_error", message: "Open Library is unavailable." } });
        }
        return jsonResponse(200, { items: searchItems });
      }
      if (method === "POST" && url.includes("/metadata/apply")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        applies.push(body);
        return jsonResponse(200, {
          book: { ...makeBook(), title: "Dune", publisher: "Chilton" },
          applied: body.fields as string[],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FindMetadata", () => {
  it("renders result cards and applies the selected fields", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["book", ID], { book: makeBook(), chapters: [], progress: null });
    renderFind(client);

    fireEvent.click(await screen.findByRole("button", { name: /Search/ }));
    expect(await screen.findByText("Dune Chronicles")).toBeTruthy();
    expect(screen.getByText(/Open Library/)).toBeTruthy();
    expect(screen.getAllByText(/93% match/).length).toBeGreaterThan(0);

    const publisherBoxes = screen.getAllByRole("checkbox", { name: "Publisher" });
    fireEvent.click(publisherBoxes[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Apply selected" })[0]!);

    await waitFor(() => expect(applies).toHaveLength(1));
    expect(applies[0]!.source).toBe("openlibrary");
    expect((applies[0]!.payload as Candidate).title).toBe("Dune");
    expect(applies[0]!.fields as string[]).toContain("title");
    expect(applies[0]!.fields as string[]).not.toContain("publisher");

    // The apply response updates the cached book.
    const cached = client.getQueryData<{ book: Book }>(["book", ID]);
    expect(cached?.book.publisher).toBe("Chilton");
  });

  it("shows an empty state when nothing matches", async () => {
    searchItems = [];
    renderFind(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    fireEvent.click(await screen.findByRole("button", { name: /Search/ }));
    expect(await screen.findByText(/No matches found/)).toBeTruthy();
  });

  it("shows a provider error message inline", async () => {
    searchStatus = 502;
    renderFind(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    fireEvent.click(await screen.findByRole("button", { name: /Search/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be reached");
  });

  it("renders saved candidates preloaded without a search", async () => {
    renderFind(new QueryClient({ defaultOptions: { queries: { retry: false } } }), [makeCandidate()]);
    expect(await screen.findByRole("button", { name: "Apply selected" })).toBeTruthy();
    expect(screen.getByText("Dune")).toBeTruthy();
  });
});
