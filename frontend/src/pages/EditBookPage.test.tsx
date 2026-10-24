import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookPage } from "./EditBookPage";
import type { Book } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";

function makeBook(): Book {
  return {
    id: ID,
    title: "Dune",
    subtitle: null,
    authors: ["Frank Herbert", "Ada Lovelace"],
    series: "Dune",
    series_index: 1,
    description: null,
    publisher: null,
    published_date: "1965",
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let patches: Record<string, unknown>[] = [];
let patchResponse: { status: number; body: unknown } = { status: 200, body: { book: makeBook() } };

function renderEdit() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/books/${ID}/edit`]}>
        <Routes>
          <Route path="/books/:id/edit" element={<EditBookPage />} />
          <Route path="/books/:id" element={<p>detail page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patches = [];
  patchResponse = { status: 200, body: { book: makeBook() } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return jsonResponse(200, { book: makeBook(), chapters: [], progress: null });
      }
      if (method === "PATCH") {
        patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(patchResponse.status, patchResponse.body);
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditBookPage", () => {
  it("PATCHes only the changed fields", async () => {
    renderEdit();
    fireEvent.change(await screen.findByLabelText("Subtitle"), { target: { value: "The Secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ subtitle: "The Secret" });
  });

  it("submits authors in the new order after a move", async () => {
    renderEdit();
    fireEvent.click(await screen.findByRole("button", { name: "Move authors 1 down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ authors: ["Ada Lovelace", "Frank Herbert"] });
  });

  it("shows the server error inline and keeps the form", async () => {
    patchResponse = {
      status: 403,
      body: { error: { code: "forbidden", message: "You can only edit books you uploaded." } },
    };
    renderEdit();
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Dune Messiah" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You can only edit books you uploaded.");
    // The form stays so the user can retry or cancel.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Dune Messiah");
  });

  it("blocks submit with an inline checksum error for a bad ISBN", async () => {
    renderEdit();
    fireEvent.change(await screen.findByLabelText("ISBN-13"), { target: { value: "9780000000000" } });
    expect(screen.getByText(/ISBN-13 checksum is not valid/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(patches).toHaveLength(0);
  });
});
