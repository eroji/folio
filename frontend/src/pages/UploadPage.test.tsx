import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useEvents } from "../hooks/useEvents";
import { UploadPage } from "./UploadPage";
import { installMockEventSource, MockEventSource } from "../test/eventsource";
import type { Book, BookStatus } from "../api/types";

const BOOK_A = "11111111-1111-1111-1111-111111111111";
const BOOK_B = "22222222-2222-2222-2222-222222222222";

/** Book statuses returned by the mocked GET /books/{id}; flip entries to
 * simulate the worker moving a book along. */
const statuses: Record<string, BookStatus> = {};

function makeBook(id: string): Book {
  return {
    id,
    title: `Book ${id.slice(0, 4)}`,
    subtitle: null,
    authors: ["Ada Lovelace"],
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
    status: statuses[id] ?? "processing",
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

/** XHR fake: one POST per file, answers from FakeXHR.results keyed by filename. */
class FakeXHR {
  static results = new Map<string, { status: number; body: unknown }>();

  status = 0;
  responseText = "";
  readonly upload = new EventTarget();
  private listeners = new Map<string, (() => void)[]>();

  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(form: FormData): void {
    const file = form.getAll("files")[0] as File;
    queueMicrotask(() => {
      this.upload.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: 40, total: 100 }));
      const result = FakeXHR.results.get(file.name) ?? {
        status: 202,
        body: [{ book_id: BOOK_A, job_id: 1, duplicate_of: null }],
      };
      this.status = result.status;
      this.responseText = JSON.stringify(result.body);
      for (const cb of this.listeners.get("load") ?? []) cb();
    });
  }
}

function renderUpload() {
  function EventsHost({ children }: { children: ReactNode }) {
    useEvents(); // the wiring AppShell provides around every authenticated page
    return <>{children}</>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EventsHost>
          <UploadPage />
        </EventsHost>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function dropFiles(names: string[]) {
  const files = names.map((name) => new File(["data"], name));
  fireEvent.drop(screen.getByText("Drop books here"), { dataTransfer: { files } });
}

beforeEach(() => {
  localStorage.clear();
  FakeXHR.results.clear();
  for (const key of Object.keys(statuses)) delete statuses[key];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  installMockEventSource();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const detail = /^\/api\/v1\/books\/([^/?]+)/.exec(String(input));
      if (detail?.[1]) {
        return jsonResponse(200, {
          book: makeBook(detail[1]),
          chapters: [
            { id: "c1", idx: 1, title: "One", char_count: 10 },
            { id: "c2", idx: 2, title: "Two", char_count: 10 },
          ],
          progress: null,
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UploadPage", () => {
  it("renders the drop zone with the pinned copy and an empty session list", () => {
    renderUpload();
    expect(screen.getByText("Drop books here")).toBeTruthy();
    expect(screen.getByText("EPUB, PDF, MOBI, AZW or AZW3 · up to 200 MB each · no DRM or KFX")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Upload" })).toBeTruthy();
    expect(screen.getByText("Add to your library")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This session" })).toBeTruthy();
    expect(screen.getByText(/appear here/i)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders one row with a determinate progress bar per dropped file", async () => {
    FakeXHR.results.set("a.epub", { status: 202, body: [{ book_id: BOOK_A, job_id: 1, duplicate_of: null }] });
    FakeXHR.results.set("b.epub", { status: 202, body: [{ book_id: BOOK_B, job_id: 2, duplicate_of: null }] });
    statuses[BOOK_A] = "processing";
    statuses[BOOK_B] = "processing";
    renderUpload();

    dropFiles(["a.epub", "b.epub"]);
    expect(screen.getByText(/a\.epub/)).toBeTruthy();
    expect(screen.getByText(/b\.epub/)).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getAllByText("Uploading · 0%")).toHaveLength(2);

    // Once each POST lands, the rows show the live book status.
    expect(await screen.findAllByText("Processing…")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe("2 in progress");
  });

  it("shows an indeterminate bar while a Kindle file converts", async () => {
    statuses[BOOK_A] = "processing";
    renderUpload();
    dropFiles(["a.azw3"]);
    expect(await screen.findByText("Converting Kindle file to EPUB…")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  it("flips a Processing row to Ready · N chapters on an SSE job frame without reload", async () => {
    statuses[BOOK_A] = "processing";
    renderUpload();
    dropFiles(["a.epub"]);
    expect(await screen.findByText("Processing…")).toBeTruthy();

    statuses[BOOK_A] = "ready";
    MockEventSource.instances[0]!.emit("job", { event: "job", job_id: 1, book_id: BOOK_A, status: "ready" });
    expect(await screen.findByText("Ready · 2 chapters")).toBeTruthy();
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByRole("link", { name: "Open book" }).getAttribute("href")).toBe(`/books/${BOOK_A}`);
    expect(await screen.findByText("1 added")).toBeTruthy();
  });

  it("flags a scanned PDF as needing OCR with a warning row", async () => {
    statuses[BOOK_A] = "needs_ocr";
    renderUpload();
    dropFiles(["scan.pdf"]);
    expect(await screen.findByText("Added · scanned PDF, needs OCR")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open book" }).getAttribute("href")).toBe(`/books/${BOOK_A}`);
  });

  it("links a duplicate upload to the existing book", async () => {
    FakeXHR.results.set("dup.epub", { status: 202, body: [{ book_id: BOOK_B, job_id: 2, duplicate_of: BOOK_A }] });
    renderUpload();
    dropFiles(["dup.epub"]);
    expect(await screen.findByText("Already in your library")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open book" }).getAttribute("href")).toBe(`/books/${BOOK_A}`);
  });

  it("shows a failed upload with the reason and removes the row", async () => {
    FakeXHR.results.set("drm.epub", {
      status: 422,
      body: {
        error: {
          code: "unsupported_format",
          message: "This file is DRM-protected or in an unsupported Kindle format",
        },
      },
    });
    renderUpload();
    dropFiles(["drm.epub"]);
    const row = (await screen.findByText(/Couldn.t add · .*DRM-protected/)).closest("li");
    expect(row).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 failed");

    fireEvent.click(screen.getByRole("button", { name: "Remove drm.epub" }));
    expect(screen.queryByText(/drm\.epub/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("summarises mixed outcomes in a polite live region", async () => {
    FakeXHR.results.set("ok.epub", { status: 202, body: [{ book_id: BOOK_A, job_id: 1, duplicate_of: null }] });
    FakeXHR.results.set("bad.epub", {
      status: 422,
      body: { error: { code: "too_large", message: "The file is larger than 200 MB" } },
    });
    statuses[BOOK_A] = "ready";
    renderUpload();
    dropFiles(["ok.epub", "bad.epub"]);
    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(await screen.findByText("1 added · 1 failed")).toBeTruthy();
  });
});
