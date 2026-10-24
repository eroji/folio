import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { BookDetailPage } from "./BookDetailPage";
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

const CANDIDATE: Candidate = {
  source: "openlibrary",
  title: "Dune",
  authors: ["Frank Herbert"],
  published_date: "1965",
  publisher: null,
  description: null,
  language: "en",
  isbn10: null,
  isbn13: null,
  series: null,
  series_index: null,
  tags: [],
  cover_url: null,
  score: 0.72,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let candidates: Candidate[] = [CANDIDATE];

beforeEach(() => {
  candidates = [CANDIDATE];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return jsonResponse(200, {
          user: { id: "u1", username: "reader", display_name: "Reader", email: null, role: "user" },
          csrf_token: "token",
        });
      }
      if (url.includes("/metadata/candidates")) return jsonResponse(200, { items: candidates });
      if (url.includes(`/books/${ID}`)) return jsonResponse(200, { book: makeBook(), chapters: [], progress: null });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/books/${ID}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/books/:id" element={<BookDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BookDetailPage", () => {
  it("shows the review banner when saved candidates exist and opens the panel preloaded", async () => {
    renderDetail();
    const review = await screen.findByRole("button", { name: "Review metadata matches" });
    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(`/books/${ID}/edit`);

    fireEvent.click(review);
    expect(await screen.findByRole("button", { name: "Apply selected" })).toBeTruthy();
    expect(screen.getByText(/72% match/)).toBeTruthy();
  });

  it("hides the banner when there are no candidates", async () => {
    candidates = [];
    renderDetail();
    expect(await screen.findByRole("link", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review metadata matches" })).toBeNull();
  });
});
