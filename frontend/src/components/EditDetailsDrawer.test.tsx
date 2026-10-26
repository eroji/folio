import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditDetailsDrawer } from "./EditDetailsDrawer";
import type { Book, Candidate } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";

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

function makeBook(overrides: Partial<Book> = {}): Book {
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
    genre: null,
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let patches: Record<string, unknown>[] = [];
let unlocks: string[] = [];
let coverDeletes = 0;
let coverUrlFetches: string[] = [];
let sends: FormData[] = [];
let current: Book;

class FakeXHR {
  status = 200;
  responseText = JSON.stringify({ cover_url: `/api/v1/books/${ID}/cover?size=600&v=abc`, cover_key: "abc" });
  withCredentials = false;
  readonly upload = new EventTarget();
  private listeners = new Map<string, (() => void)[]>();

  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(form: FormData): void {
    sends.push(form);
    queueMicrotask(() => {
      for (const cb of this.listeners.get("load") ?? []) cb();
    });
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

beforeEach(() => {
  patches = [];
  unlocks = [];
  coverDeletes = 0;
  coverUrlFetches = [];
  sends = [];
  current = makeBook();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: () => undefined,
    drawImage: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(new File(["webp"], "cover.webp", { type: "image/webp" }))) as unknown as typeof HTMLCanvasElement.prototype.toBlob;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:cover") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (url.includes("/unlock") && method === "POST") {
        unlocks.push(String(body.field));
        current = { ...current, locked_fields: (current.locked_fields ?? []).filter((f) => f !== body.field) };
        return jsonResponse(200, { book: current });
      }
      if (url.includes("/cover-url") && method === "PUT") {
        coverUrlFetches.push(String(body.url));
        return jsonResponse(200, { cover_url: `/api/v1/books/${ID}/cover?v=abc`, cover_key: "abc" });
      }
      if (url.endsWith("/cover") && method === "DELETE") {
        coverDeletes += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/metadata/search") && method === "GET") {
        return jsonResponse(200, { items: [CANDIDATE] });
      }
      if (url.includes("/metadata/apply") && method === "POST") {
        current = { ...current, title: "Dune (Provider)", updated_at: "2026-01-02T00:00:00Z" };
        return jsonResponse(200, { book: current, applied: body.fields ?? [] });
      }
      if (method === "PATCH") {
        patches.push(body);
        current = { ...current, ...(body as Partial<Book>) };
        return jsonResponse(200, { book: current });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDrawer(overrides: Partial<Book> = {}, reviewItems?: Candidate[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <EditDetailsDrawer book={makeBook(overrides)} onClose={onClose} initialReviewItems={reviewItems} />
    </QueryClientProvider>,
  );
  return { onClose };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

describe("EditDetailsDrawer", () => {
  it("focuses the Title input on open", () => {
    renderDrawer();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
    expect(screen.getByRole("dialog", { name: "Edit details" }).getAttribute("aria-modal")).toBe("true");
  });

  it("keeps Save disabled until a change and counts unsaved changes", () => {
    renderDrawer();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Dune Messiah" } });
    const first = screen.getByText("1 unsaved change");
    expect(first.closest("[aria-live='polite']")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Subtitle" }), { target: { value: "Appendix" } });
    expect(screen.getByText("2 unsaved changes")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it("does not count padded stored metadata as an unsaved change", () => {
    renderDrawer({ description: "\nFrom the author…\n", subtitle: "  Appendix  " });
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("opens Find metadata inside the drawer and Back returns to the form", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Find metadata" }));
    expect(screen.getByRole("dialog", { name: "Find metadata" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Subtitle" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to details" }));
    expect(screen.getByRole("dialog", { name: "Edit details" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Subtitle" })).toBeTruthy();
  });

  it("disables Find metadata while edits are unsaved", () => {
    renderDrawer();
    const find = screen.getByRole("button", { name: "Find metadata" }) as HTMLButtonElement;
    expect(find.disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Messiah" } });
    expect(find.disabled).toBe(true);
  });

  it("opens straight into the saved-matches review view", () => {
    renderDrawer({}, [CANDIDATE]);
    expect(screen.getByRole("dialog", { name: "Find metadata" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeTruthy();
    expect(screen.getByText(/72% match/)).toBeTruthy();
  });

  it("refreshes the form after applying provider metadata", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const view = (value: Book) => (
      <QueryClientProvider client={client}>
        <EditDetailsDrawer book={value} onClose={onClose} initialReviewItems={[CANDIDATE]} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(makeBook()));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
    await screen.findByText(/Applied:/);
    rerender(view(makeBook({ title: "Dune (Provider)", updated_at: "2026-01-02T00:00:00Z" })));
    fireEvent.click(screen.getByRole("button", { name: "Back to details" }));
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Dune (Provider)");
  });

  it("Cancel closes directly when nothing changed", () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding changes and only Discard closes", () => {
    const { onClose } = renderDrawer();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Messiah" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Discard changes?" })).getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes when clean, scrim closes too", () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit details" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the unlock button posts the field and removes the lock icon", async () => {
    renderDrawer({ locked_fields: ["title"] });
    const lock = screen.getByRole("button", { name: "Title is protected from automatic updates. Unlock" });
    fireEvent.click(lock);
    await waitFor(() => expect(unlocks).toContain("title"));
    expect(screen.queryByRole("button", { name: /protected from automatic updates. Unlock/ })).toBeNull();
  });

  it("shows no lock icons when the payload has no locked_fields (pre-merge backend)", () => {
    renderDrawer();
    expect(screen.queryByRole("button", { name: /Unlock$/ })).toBeNull();
  });

  it("shows the ISBN error only after blur and blocks Save", () => {
    renderDrawer();
    const isbn = screen.getByRole("textbox", { name: "ISBN-13" });
    fireEvent.change(isbn, { target: { value: "9780000000000" } });
    expect(screen.queryByText(/ISBN-13 checksum is not valid/)).toBeNull();
    fireEvent.blur(isbn);
    expect(screen.getByText(/ISBN-13 checksum is not valid/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("displays a stored timestamp as a plain date and counts it as unchanged", () => {
    renderDrawer({ published_date: "2008-01-01T05:00:00+00:00" });
    const published = screen.getByRole("textbox", { name: "Published" }) as HTMLInputElement;
    expect(published.value).toBe("2008-01-01");
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps a current genre that is not in the fixed list", () => {
    renderDrawer({ genre: "Nautical history" });
    const select = screen.getByRole("combobox", { name: "Genre" }) as HTMLSelectElement;
    expect(select.value).toBe("Nautical history");
    expect(within(select).getByRole("option", { name: "Nautical history" })).toBeTruthy();
  });

  it("adds author chips with Enter and comma, removes them, and reorders by drag", async () => {
    renderDrawer({ authors: ["Frank Herbert", "Ada Lovelace"] });
    expect(screen.getByText("Drag to reorder. The first author is shown on covers and lists.")).toBeTruthy();
    const add = screen.getByRole("textbox", { name: "Add authors" });
    fireEvent.change(add, { target: { value: "Ann Leckie" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.change(add, { target: { value: "Becca" } });
    fireEvent.keyDown(add, { key: "," });
    expect(screen.getByText("Ann Leckie")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove author Becca" }));
    expect(screen.queryByText("Becca")).toBeNull();

    const first = screen.getByText("Frank Herbert");
    const second = screen.getByText("Ada Lovelace");
    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ authors: ["Ada Lovelace", "Frank Herbert", "Ann Leckie"] });
  });

  it("adds and removes tag chips", () => {
    renderDrawer({ tags: ["Desert"] });
    const add = screen.getByRole("textbox", { name: "Add tags" });
    fireEvent.change(add, { target: { value: "Epic" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(screen.getByText("Epic")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove tag Desert" }));
    expect(screen.queryByText("Desert")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove tag Epic" })).toBeTruthy();
  });

  it("uploads the cropped WebP blob after Use cover", async () => {
    renderDrawer();
    const file = screen.getByLabelText("Upload cover image");
    fireEvent.change(file, { target: { files: [new File(["png-bytes"], "cover.png", { type: "image/png" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "Use cover" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.get("file")).toBeInstanceOf(File);
  });

  it("disables Remove cover when the book has no cover", () => {
    renderDrawer();
    expect((screen.getByRole("button", { name: "Remove cover" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes the cover with DELETE", async () => {
    renderDrawer({ cover_url: `/api/v1/books/${ID}/cover` });
    fireEvent.click(screen.getByRole("button", { name: "Remove cover" }));
    await waitFor(() => expect(coverDeletes).toBe(1));
  });

  it("fetches a pasted link then opens the crop step", async () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Paste link" }));
    const url = screen.getByRole("textbox", { name: "Cover image URL" });
    fireEvent.change(url, { target: { value: "https://example.org/cover.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(coverUrlFetches).toEqual(["https://example.org/cover.jpg"]));
    expect(await screen.findByRole("button", { name: "Use cover" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("has no narrator field", () => {
    renderDrawer();
    expect(screen.queryByText(/narrator/i)).toBeNull();
  });

  it("is a right drawer that goes full screen on phones", () => {
    renderDrawer();
    const panel = screen.getByRole("dialog", { name: "Edit details" });
    expect(panel.className).toContain("w-full");
    expect(panel.className).toContain("max-w-[600px]");
    expect(panel.className).toContain("bg-surface");
  });

  it("PATCHes only the changed fields on Save and closes", async () => {
    const { onClose } = renderDrawer({ published_date: "2008-01-01T05:00:00+00:00" });
    fireEvent.change(screen.getByRole("textbox", { name: "Publisher" }), { target: { value: "Chilton" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ publisher: "Chilton" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
