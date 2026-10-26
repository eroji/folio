import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditDetailsDrawer } from "./EditDetailsDrawer";
import type { Book, Candidate } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";

/** Differs from the default book in publisher, published, description, isbn13,
 * tags, genre and cover; title, authors and language already match. */
const CANDIDATE_A: Candidate = {
  source: "openlibrary",
  title: "Dune",
  authors: ["Frank Herbert"],
  published_date: "1965",
  publisher: "Chilton",
  description: "<p>A classic of <i>desert</i> politics.</p>",
  language: "en",
  isbn10: null,
  isbn13: "9780441013593",
  series: null,
  series_index: null,
  tags: ["Desert"],
  cover_url: "https://covers.test/dune.jpg",
  score: 0.96,
  suggested_genre: "Science Fiction",
};

const CANDIDATE_B: Candidate = {
  ...CANDIDATE_A,
  source: "googlebooks",
  publisher: "Ace",
  published_date: "2002",
  description: null,
  isbn13: null,
  tags: [],
  cover_url: null,
  suggested_genre: null,
  score: 0.9,
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
let searchUrls: string[] = [];
let searchItems: Candidate[] = [];
let calls: string[] = [];
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

/** Width-aware matchMedia so the drawer's 1100 px overlay breakpoint is testable. */
function stubViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  patches = [];
  unlocks = [];
  coverDeletes = 0;
  coverUrlFetches = [];
  searchUrls = [];
  searchItems = [CANDIDATE_A, CANDIDATE_B];
  calls = [];
  sends = [];
  current = makeBook();
  stubViewport(1440);
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
        calls.push("put-cover");
        coverUrlFetches.push(String(body.url));
        return jsonResponse(200, { cover_url: `/api/v1/books/${ID}/cover?v=abc`, cover_key: "abc" });
      }
      if (url.endsWith("/cover") && method === "DELETE") {
        coverDeletes += 1;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/metadata/search") && method === "GET") {
        searchUrls.push(url);
        return jsonResponse(200, { items: searchItems });
      }
      if (method === "PATCH") {
        calls.push("patch");
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

function panel(): HTMLElement {
  return screen.getByRole("dialog", { name: "Edit details" });
}

function input(name: string): HTMLInputElement {
  return screen.getByRole("textbox", { name }) as HTMLInputElement;
}

/** Opens the pane through the pill and waits for the auto-searched rows. */
async function openFindPane() {
  fireEvent.click(screen.getByRole("button", { name: "Find metadata" }));
  await screen.findByRole("button", { name: /96%/ });
}

describe("EditDetailsDrawer", () => {
  it("focuses the Title input on open", () => {
    renderDrawer();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
    expect(panel().getAttribute("aria-modal")).toBe("true");
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

  it("opens Find beside the form: widens, keeps the form and unsaved edits, X collapses", async () => {
    renderDrawer();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Messiah" } });
    const find = screen.getByRole("button", { name: "Find metadata" }) as HTMLButtonElement;
    expect(find.disabled).toBe(false);
    fireEvent.click(find);
    expect(panel().className).toContain("max-w-[1000px]");
    expect(screen.getByRole("region", { name: "Find metadata" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Messiah");
    expect(screen.getByText("Pick a result, then use the suggestions in the form.")).toBeTruthy();
    await screen.findByRole("button", { name: /96%/ });
    fireEvent.click(screen.getByRole("button", { name: "Close find metadata" }));
    expect(screen.queryByRole("region", { name: "Find metadata" })).toBeNull();
    expect(panel().className).toContain("max-w-[600px]");
  });

  it("auto-searches with the prefilled query, reports the sources and selects the best match", async () => {
    renderDrawer({ isbn13: "9780441013593" });
    fireEvent.click(screen.getByRole("button", { name: "Find metadata" }));
    await waitFor(() => expect(searchUrls).toHaveLength(1));
    expect(searchUrls[0]).toContain("q=Dune+Frank+Herbert");
    expect((screen.getByRole("searchbox", { name: "Title or author" }) as HTMLInputElement).value).toBe(
      "Dune Frank Herbert",
    );
    expect((screen.getByRole("textbox", { name: "ISBN" }) as HTMLInputElement).value).toBe("9780441013593");
    expect(await screen.findByText("2 results from Google Books and Open Library")).toBeTruthy();
    expect(screen.getByRole("button", { name: /96%/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /90%/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("selecting another result only swaps the suggestions driving the form", async () => {
    renderDrawer();
    await openFindPane();
    expect(screen.getByText("Chilton")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /90%/ }));
    expect(await screen.findByText("Ace")).toBeTruthy();
    expect(screen.queryByText("Chilton")).toBeNull();
    expect((input("Publisher") as HTMLInputElement).value).toBe("");
  });

  it("Use fills the field, shows the source line and counts the change; Undo restores", async () => {
    renderDrawer();
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use Chilton" }));
    expect(input("Publisher").value).toBe("Chilton");
    expect(screen.getByText("From Open Library")).toBeTruthy();
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo Publisher" }));
    expect(input("Publisher").value).toBe("");
    expect(screen.queryByText("From Open Library")).toBeNull();
    expect(screen.getByRole("button", { name: "Use Chilton" })).toBeTruthy();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("Use all fills every differing field, skips locked ones and defers the cover", async () => {
    renderDrawer({ locked_fields: ["publisher"] });
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use all" }));
    expect(input("Publisher").value).toBe("");
    expect(input("Published").value).toBe("1965");
    expect(input("ISBN-13").value).toBe("9780441013593");
    expect((screen.getByRole("combobox", { name: "Genre" }) as HTMLSelectElement).value).toBe("Science Fiction");
    expect(screen.getByText("Desert")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe(
      "A classic of desert politics.",
    );
    expect(coverUrlFetches).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Undo cover" })).toBeTruthy();
  });

  it("typing after Use makes the field hand-edited again: no metadata_fields on Save", async () => {
    renderDrawer();
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use Chilton" }));
    fireEvent.change(input("Publisher"), { target: { value: "Chilton Press" } });
    expect(screen.queryByText("From Open Library")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ publisher: "Chilton Press" });
  });

  it("Save sends metadata_fields for used suggestions and lists typed fields only as changes", async () => {
    const { onClose } = renderDrawer();
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use Chilton" }));
    fireEvent.change(input("Subtitle"), { target: { value: "Appendix" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      publisher: "Chilton",
      subtitle: "Appendix",
      metadata_fields: ["publisher"],
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a used cover PUTs cover-url before the PATCH on Save", async () => {
    renderDrawer({ cover_url: "https://example.org/current.jpg" });
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use cover from Open Library" }));
    expect(coverUrlFetches).toHaveLength(0);
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(coverUrlFetches).toEqual(["https://covers.test/dune.jpg"]);
    expect(calls.indexOf("put-cover")).toBeLessThan(calls.indexOf("patch"));
    expect(patches[0]).toEqual({});
  });

  it("under 1100 px the pane overlays the form and a pick closes it with suggestions kept", async () => {
    stubViewport(900);
    renderDrawer();
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: /90%/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Find metadata" })).toBeNull());
    expect(panel().className).toContain("max-w-[600px]");
    expect(screen.getByText("Ace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use all" })).toBeTruthy();
  });

  it("closing the pane with X clears unused pills but keeps used values and their lines", async () => {
    renderDrawer();
    await openFindPane();
    fireEvent.click(screen.getByRole("button", { name: "Use Chilton" }));
    fireEvent.click(screen.getByRole("button", { name: "Close find metadata" }));
    expect(screen.getByText("From Open Library")).toBeTruthy();
    expect(input("Publisher").value).toBe("Chilton");
    expect(screen.queryByRole("button", { name: "Use all" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use 978/ })).toBeNull();
  });

  it("opens straight into the pane with preloaded review items and no auto-search", () => {
    renderDrawer({}, [CANDIDATE_A]);
    expect(screen.getByRole("region", { name: "Find metadata" })).toBeTruthy();
    expect(searchUrls).toHaveLength(0);
    expect(screen.getByRole("button", { name: /96%/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Use all" })).toBeTruthy();
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

  it("Escape closes the pane first, then the drawer", () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Find metadata" }));
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Find metadata" })).toBeNull();
    fireEvent.keyDown(panel(), { key: "Escape" });
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
    expect(input("Published").value).toBe("2008-01-01");
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
    expect(panel().className).toContain("w-full");
    expect(panel().className).toContain("max-w-[600px]");
    expect(panel().className).toContain("bg-surface");
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
