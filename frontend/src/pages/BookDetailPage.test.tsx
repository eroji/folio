import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { BookDetailPage } from "./BookDetailPage";
import { makeProgress } from "../test/player";
import type { Book, Candidate, Chapter, Progress } from "../api/types";

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

const CHAPTERS: Chapter[] = [
  { id: "c1", idx: 1, title: "One Way", char_count: 500 },
  { id: "c2", idx: 2, title: "The Other", char_count: 500 },
];

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let candidates: Candidate[] = [CANDIDATE];
let book: Book = makeBook();
let chapters: Chapter[] = CHAPTERS;
let progress: Progress | null = null;

beforeEach(() => {
  candidates = [CANDIDATE];
  book = makeBook();
  chapters = CHAPTERS;
  progress = null;
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes(`/books/${ID}`)) {
        book = { ...book, ...(JSON.parse(String(init.body)) as Partial<Book>) };
        return jsonResponse(200, { book });
      }
      if (url.includes("/auth/me")) {
        return jsonResponse(200, {
          user: { id: "u1", username: "reader", display_name: "Reader", email: null, role: "user" },
          csrf_token: "token",
        });
      }
      if (url.includes("/metadata/candidates")) return jsonResponse(200, { items: candidates });
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      if (url.includes(`/books/${ID}/progress/finished`) && init?.method === "PUT") {
        const { finished } = JSON.parse(String(init.body)) as { finished: boolean };
        progress = makeProgress({ finished_at: finished ? "2026-01-03T00:00:00Z" : null });
        return jsonResponse(200, { progress });
      }
      if (url.includes(`/books/${ID}/progress`)) {
        if (init?.method === "DELETE") {
          progress = null;
          return new Response(null, { status: 204 });
        }
        return jsonResponse(200, { progress });
      }
      if (url.includes(`/books/${ID}`)) return jsonResponse(200, { book, chapters, progress });
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

  it("links Play to the player with the book and the first chapter", async () => {
    renderDetail();
    const play = await screen.findByRole("link", { name: "Play" });
    expect(play.getAttribute("href")).toBe(`/player?book=${ID}&chapter=c1`);
  });

  it("disables Play with no playable chapters", async () => {
    chapters = [];
    renderDetail();
    const play = await screen.findByRole("button", { name: "No playable chapters" });
    expect((play as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the narrator voice override as the only patched field", async () => {
    renderDetail();
    await screen.findByRole("option", { name: "ashley-en" });
    const select = screen.getByRole("combobox", { name: "en voice" });
    fireEvent.change(select, { target: { value: "ashley-en" } });
    await vi.waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ narrator_voice: "ashley-en" });
    });
    expect(await screen.findByText(/about 10m/)).toBeTruthy();
  });

  it("shows Resume with the saved position and offers progress actions", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2" });
    renderDetail();
    const resume = await screen.findByRole("link", { name: /Resume/ });
    expect(resume.getAttribute("href")).toBe(`/player?book=${ID}&chapter=c2`);
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark finished" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset progress" })).toBeTruthy();
  });

  it("marks finished and back with the finished flag in the body", async () => {
    progress = makeProgress({ percent: 40 });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Mark finished" }));
    await screen.findByText("Finished");
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([, init]) => String(init?.body ?? "").includes('"finished":true'));
      expect(call).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark unfinished" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([, init]) => String(init?.body ?? "").includes('"finished":false'));
      expect(call).toBeTruthy();
    });
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("resets progress with a DELETE and falls back to Play", async () => {
    progress = makeProgress({ percent: 40 });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Reset progress" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/progress`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    await screen.findByRole("link", { name: "Play" });
    expect(screen.queryByText("40%")).toBeNull();
  });
});
