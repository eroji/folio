import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoverEditor } from "./CoverEditor";
import type { Book } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";
const webpFile = new File(["webp-bytes"], "cover.webp", { type: "image/webp" });

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

let drawImages: unknown[][] = [];
let sends: FormData[] = [];

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
  drawImages = [];
  sends = [];
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: () => undefined,
    drawImage: (...args: unknown[]) => {
      drawImages.push(args);
    },
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => cb(webpFile)) as unknown as typeof HTMLCanvasElement.prototype.toBlob;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:cover") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
  vi.unstubAllGlobals();
});

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CoverEditor book={makeBook()} />
    </QueryClientProvider>,
  );
}

function pickFile(file: File): void {
  fireEvent.change(screen.getByLabelText(/Upload image/), { target: { files: [file] } });
}

describe("CoverEditor", () => {
  it("exports a 2:3 WebP and uploads it after Save cover", async () => {
    renderEditor();
    pickFile(new File(["png-bytes"], "cover.png", { type: "image/png" }));

    fireEvent.click(await screen.findByRole("button", { name: "Crop to 2:3" }));
    const preview = await screen.findByAltText("Cropped cover preview");
    expect(preview.getAttribute("src")).toBe("blob:cover");

    fireEvent.click(screen.getByRole("button", { name: "Save cover" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.get("file")).toBeInstanceOf(File);

    // The export drawImage renders into a 1200x1800 (2:3) destination.
    const exportCall = drawImages.find(
      (args) => args[args.length - 2] === 1200 && args[args.length - 1] === 1800,
    );
    expect(exportCall).toBeTruthy();
  });

  it("uploads the original file untouched", async () => {
    renderEditor();
    pickFile(new File(["png-bytes"], "cover.png", { type: "image/png" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload as-is" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.get("file")).toBeInstanceOf(File);
  });

  it("rejects a non-JPEG/PNG/WebP file before any request", async () => {
    renderEditor();
    pickFile(new File(["gif"], "cover.gif", { type: "image/gif" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("JPEG, PNG or WebP");
    expect(screen.queryByRole("button", { name: "Crop to 2:3" })).toBeNull();
  });

  it("rejects a file over 10 MB", async () => {
    renderEditor();
    const big = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    pickFile(big);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("10 MB");
  });
});
