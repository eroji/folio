import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { BookDetailPage } from "./BookDetailPage";
import { PlayerProvider } from "../player/PlayerProvider";
import { installMockEventSource, MockEventSource } from "../test/eventsource";
import { makeProgress, stubMedia } from "../test/player";
import { DEFAULT_SETTINGS } from "../api/settings";
import type { Segment } from "../api/audio";
import type { PronunciationRule } from "../api/pronunciation";
import type { Book, Candidate, Chapter, Progress, Role } from "../api/types";

const ID = "11111111-1111-1111-1111-111111111111";

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
  { id: "c1", idx: 0, title: "One Way", char_count: 500 },
  { id: "c2", idx: 1, title: "The Other", char_count: 500 },
];

// Contiguous 250-char segments so progress PUTs can recompute percent.
const SEGMENTS: Record<string, Segment[]> = {
  c1: [
    { id: "s1", idx: 0, text: "one", char_start: 0, char_end: 250 },
    { id: "s2", idx: 1, text: "two", char_start: 250, char_end: 500 },
  ],
  c2: [
    { id: "s3", idx: 0, text: "three", char_start: 0, char_end: 250 },
    { id: "s4", idx: 1, text: "four", char_start: 250, char_end: 500 },
  ],
};

function makeRule(overrides: Partial<PronunciationRule> = {}): PronunciationRule {
  return {
    id: "r1",
    match: "Leto",
    say: "Lee-toh",
    whole_word: true,
    after_number: false,
    case_sensitive: false,
    ...overrides,
  };
}

const VOICES = {
  defaults: { en: "zoe-en" },
  items: [
    { id: "ashley-en", language: "en", description: null, available: true, display_name: "Ashley" },
    // No display_name: the dialog must fall back to the parsed name ("Zoe").
    { id: "zoe-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    // Tagged on purpose: the dialog must hide "tts" even if the API sends it.
    { id: "tts", language: "en", description: "engine default", available: true },
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
let role: Role = "user";
let rules: PronunciationRule[] = [];
let rulesFail = false;
let ruleSeq = 1;
let prepareCalls: { segment_id: string; voice?: string }[] = [];
let finishedCalls: { finished: boolean }[] = [];
let saveCalls: Record<string, unknown>[] = [];
let chapterPatchBodies: Record<string, unknown>[] = [];
let chapterPatchFails = false;
let reprocessCalls = 0;
let unlocks: string[] = [];
let prepareStatuses: Record<string, string> = {};
let media: { played: HTMLMediaElement[]; paused: HTMLMediaElement[] };

beforeEach(() => {
  candidates = [CANDIDATE];
  book = makeBook();
  chapters = CHAPTERS;
  progress = null;
  role = "user";
  rules = [];
  rulesFail = false;
  ruleSeq = 1;
  prepareCalls = [];
  finishedCalls = [];
  saveCalls = [];
  chapterPatchBodies = [];
  chapterPatchFails = false;
  reprocessCalls = 0;
  unlocks = [];
  prepareStatuses = {};
  localStorage.clear();
  installMockEventSource();
  media = stubMedia();
  URL.createObjectURL = vi.fn(() => "blob:preview-1");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      const ruleCollection = url.match(new RegExp(`/books/${ID}/pronunciation$`));
      if (ruleCollection) {
        if (method === "POST") {
          if (rulesFail) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
          const rule: PronunciationRule = { id: `r${ruleSeq++}`, ...(body as Omit<PronunciationRule, "id">) };
          rules = [...rules, rule];
          return jsonResponse(200, { rule });
        }
        return jsonResponse(200, { items: rules });
      }
      const ruleItem = url.match(new RegExp(`/books/${ID}/pronunciation/([^/?]+)$`));
      if (ruleItem) {
        if (method === "DELETE") {
          if (rulesFail) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
          rules = rules.filter((rule) => rule.id !== ruleItem[1]);
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH") {
          if (rulesFail) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
          const rule = rules.find((candidate) => candidate.id === ruleItem[1]);
          if (!rule) return jsonResponse(404, { error: { code: "not_found", message: "not_found" } });
          const next = { ...rule, ...body };
          rules = rules.map((candidate) => (candidate.id === rule.id ? next : candidate));
          return jsonResponse(200, { rule: next });
        }
      }
      const chapterPatch = url.match(new RegExp(`/books/${ID}/chapters/([^/?]+)$`));
      if (chapterPatch && method === "PATCH") {
        if (chapterPatchFails) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
        chapterPatchBodies.push({ ...body, chapterId: chapterPatch[1] });
        chapters = chapters.map((chapter) => (chapter.id === chapterPatch[1] ? { ...chapter, excluded: body.excluded as boolean } : chapter));
        return jsonResponse(200, { chapter: chapters.find((chapter) => chapter.id === chapterPatch[1]) });
      }
      if (url.includes(`/books/${ID}/progress/finished`) && method === "PUT") {
        // Like the server: the toggle updates an existing row and 404s without one.
        if (!progress) return jsonResponse(404, { error: { code: "not_found", message: "Progress not found." } });
        const { finished } = body as { finished: boolean };
        finishedCalls.push({ finished });
        progress = { ...progress, finished_at: finished ? "2026-01-03T00:00:00Z" : null };
        return jsonResponse(200, { progress });
      }
      const progressMatch = url.match(new RegExp(`/books/${ID}/progress$`));
      if (progressMatch) {
        if (method === "DELETE") {
          progress = null;
          return new Response(null, { status: 204 });
        }
        if (method === "PUT") {
          const save = body as { chapter_id: string; segment_id: string; offset_s: number; device_label: string };
          saveCalls.push(save);
          const chapter = chapters.find((candidate) => candidate.id === save.chapter_id) ?? chapters[0]!;
          const segment = (SEGMENTS[chapter.id] ?? []).find((candidate) => candidate.id === save.segment_id);
          const before = chapters
            .filter((candidate) => candidate.idx < chapter.idx && !candidate.excluded)
            .reduce((sum, candidate) => sum + candidate.char_count, 0);
          progress = {
            chapter_id: chapter.id,
            segment_id: save.segment_id,
            offset_s: save.offset_s,
            percent: ((before + (segment?.char_start ?? 0)) / book.total_chars) * 100,
            device_label: save.device_label,
            updated_at: "2026-01-02T00:00:00Z",
            finished_at: progress?.finished_at ?? null,
          };
          return jsonResponse(200, { progress, ahead_of_other_device: false });
        }
        return jsonResponse(200, { progress });
      }
      const segments = url.match(new RegExp(`/books/${ID}/chapters/([^/?]+)/segments`));
      if (segments) return jsonResponse(200, { items: SEGMENTS[segments[1]!] ?? [] });
      if (url.includes("/audio/prepare")) {
        const prepare = body as { segment_id: string; count: number; voice?: string };
        prepareCalls.push(prepare);
        const all = Object.values(SEGMENTS).flat();
        const from = Math.max(0, all.findIndex((segment) => segment.id === prepare.segment_id));
        return jsonResponse(200, {
          items: all.slice(from, from + prepare.count).map((segment) => ({
            segment_id: segment.id,
            status: prepareStatuses[segment.id] ?? "ready",
            cache_key: segment.id,
            url: `/api/v1/audio/${segment.id}`,
            duration_s: 10,
          })),
        });
      }
      if (url.endsWith("/reprocess") && method === "POST") {
        reprocessCalls += 1;
        return jsonResponse(200, {});
      }
      if (url.includes(`/books/${ID}/unlock`) && method === "POST") {
        unlocks.push(String(body.field));
        book = { ...book, locked_fields: (book.locked_fields ?? []).filter((field) => field !== body.field) };
        return jsonResponse(200, { book });
      }
      if (method === "PATCH" && url.includes(`/books/${ID}`)) {
        book = { ...book, ...(body as Partial<Book>) };
        return jsonResponse(200, { book });
      }
      if (url.includes("/auth/me")) {
        return jsonResponse(200, {
          user: { id: "u1", username: "reader", display_name: "Reader", email: null, role },
          csrf_token: "token",
        });
      }
      if (url.includes("/me/settings")) return jsonResponse(200, { settings: DEFAULT_SETTINGS });
      if (url.includes("/metadata/candidates")) return jsonResponse(200, { items: candidates });
      if (url.includes("/metadata/search")) return jsonResponse(200, { items: candidates });
      if (url.includes("/voices/preview")) {
        return { ok: true, status: 200, blob: async () => new Blob(["opus-bytes"]) } as Response;
      }
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      if (url.includes(`/books/${ID}`)) return jsonResponse(200, { book, chapters, progress });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function WhereAmI() {
  const location = useLocation();
  return <p>at {location.pathname}{location.search}</p>;
}

function renderDetail(path = `/books/${ID}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <PlayerProvider>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<WhereAmI />} />
              <Route path="/library" element={<WhereAmI />} />
              <Route path="/search" element={<WhereAmI />} />
              <Route path="/books/:id" element={<BookDetailPage />} />
              <Route path="/books/:id/edit" element={<BookDetailPage />} />
              <Route path="/player" element={<WhereAmI />} />
            </Routes>
          </AuthProvider>
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Render at the desktop breakpoint (≥768px) instead of the phone default. */
function stubViewport(desktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

async function openMore() {
  fireEvent.click(await screen.findByRole("button", { name: "More options for this book" }));
}

async function openNarratorDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /^Narrator voice, / }));
  return screen.findByRole("dialog", { name: "Narrator voice" });
}

function lastPatchBody(): unknown {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
  return JSON.parse(String(call?.[1]?.body ?? "null"));
}

describe("BookDetailPage", () => {
  it("plays from the start when the book was never started and turns into Pause", async () => {
    renderDetail();
    const play = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(play);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
    const pause = await screen.findByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    await vi.waitFor(() => expect(media.paused.length).toBeGreaterThan(0));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("shows Resume when progress exists and plays from the saved chapter", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const resume = await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s3")).toBe(true));
  });

  it("labels the primary action Play and starts at the first included chapter when the saved chapter is excluded", async () => {
    chapters = [
      { id: "c1", idx: 0, title: "One Way", char_count: 500, excluded: true },
      { id: "c2", idx: 1, title: "The Other", char_count: 500 },
    ];
    progress = makeProgress({ percent: 16, chapter_id: "c1", segment_id: "s2", offset_s: 7 });
    renderDetail();
    const play = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(play);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s3")).toBe(true));
    expect(prepareCalls.every((call) => call.segment_id === "s3" || call.segment_id === "s4")).toBe(true);
  });

  it("disables the primary action when every chapter is excluded", async () => {
    chapters = [
      { id: "c1", idx: 0, title: "One Way", char_count: 500, excluded: true },
      { id: "c2", idx: 1, title: "The Other", char_count: 500, excluded: true },
    ];
    renderDetail();
    const play = (await screen.findByRole("button", { name: "Play" })) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
  });

  it("labels a finished book Play again and restarts it from chapter 1", async () => {
    progress = makeProgress({ percent: 100, chapter_id: "c2", segment_id: "s4", finished_at: "2026-01-03T00:00:00Z" });
    renderDetail();
    const again = await screen.findByRole("button", { name: "Play again" });
    fireEvent.click(again);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
  });

  it("disables the primary action for a failed book", async () => {
    book = makeBook({ status: "failed", error: "Could not extract text." });
    renderDetail();
    const play = (await screen.findByRole("button", { name: "Play" })) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/Could not extract text/);
  });

  it("shows the accent progress bar but no percent pill on the cover, and names the state", async () => {
    progress = makeProgress({ percent: 38, chapter_id: "c2", segment_id: "s3" });
    renderDetail();
    const cover = await screen.findByRole("img", { name: "Dune, 38% listened" });
    // The bar: an aria-hidden track with a width-styled accent fill.
    expect(cover.querySelector("[aria-hidden='true'] span[style*='width']")).toBeTruthy();
    // The percent pill is Home-only.
    expect(cover.querySelector("[data-testid='cover-percent']")).toBeNull();
  });

  it("shows a round accent check and no percent when the book is finished", async () => {
    stubViewport(true);
    progress = makeProgress({ percent: 100, chapter_id: "c2", segment_id: "s4", finished_at: "2026-01-03T00:00:00Z" });
    renderDetail();
    expect(await screen.findByRole("img", { name: "Dune, finished" })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /One Way/ })).getByText("Played")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /The Other/ })).getByText("Played")).toBeTruthy();
    // Played rows show the check only — no duration.
    expect(screen.queryByText("5:00")).toBeNull();
  });

  it("marks finished from the ⋮ menu, shows the undo toast, and undo unmarks", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as finished" }));
    const message = await screen.findByText("Marked as finished");
    expect(message.closest('[aria-live="polite"]')).toBeTruthy();
    await vi.waitFor(() => expect(finishedCalls).toContainEqual({ finished: true }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() => expect(finishedCalls).toContainEqual({ finished: false }));
  });

  it("creates a progress row at the first segment before marking a fresh book finished", async () => {
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as finished" }));
    await vi.waitFor(() => expect(finishedCalls).toContainEqual({ finished: true }));
    expect(saveCalls[0]).toMatchObject({ chapter_id: "c1", segment_id: "s1", offset_s: 0 });
  });

  it("offers Mark as unfinished once finished", async () => {
    progress = makeProgress({ percent: 100, chapter_id: "c2", segment_id: "s4", finished_at: "2026-01-03T00:00:00Z" });
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as unfinished" }));
    await vi.waitFor(() => expect(finishedCalls).toContainEqual({ finished: false }));
  });

  it("closes the book menu with Escape and returns focus to the trigger", async () => {
    renderDetail();
    const trigger = await screen.findByRole("button", { name: "More options for this book" });
    fireEvent.click(trigger);
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Mark as finished" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("requires confirmation before resetting progress, then starts at chapter 1", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2", segment_id: "s4" });
    localStorage.setItem(`folio-pos-${ID}`, JSON.stringify(makeProgress({ percent: 40 })));
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset your progress in Dune?" });
    expect(within(dialog).getByText("This cannot be undone.")).toBeTruthy();

    // Cancel does not delete anything.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Resume" });
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => init?.method === "DELETE" && String(url).includes("/progress"))).toBe(false);

    // Confirm deletes, clears the local position and starts playback at chapter 1.
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset progress" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/progress`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    // The stale local position is cleared; playing chapter 1 then rewrites it.
    await vi.waitFor(() => {
      const stored = localStorage.getItem(`folio-pos-${ID}`);
      expect(stored ? JSON.parse(stored).chapter_id : null).toBe("c1");
    });
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
  });

  it("switches tabs with the arrow keys", async () => {
    renderDetail();
    const chaptersTab = await screen.findByRole("tab", { name: "Chapters" });
    expect(chaptersTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(chaptersTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "About" }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("book-tab-About");
    fireEvent.keyDown(screen.getByRole("tab", { name: "About" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Chapters" }).getAttribute("aria-selected")).toBe("true");
  });

  it("scrolls the chapters list internally instead of growing the page", async () => {
    renderDetail();
    await screen.findByRole("tab", { name: "Chapters" });
    const list = document.querySelector("#book-panel ol")!;
    expect(list.className).toContain("max-h-[60vh]");
    expect(list.className).toContain("scroll-thin");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("marks chapters before the saved position as played and the saved one as current", async () => {
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const played = await screen.findByRole("button", { name: /One Way/ });
    expect(within(played).getByText("Played")).toBeTruthy();
    expect(played.querySelector("svg")).toBeTruthy(); // the check icon
    expect(within(played).queryByText("5:00")).toBeNull(); // played rows show the check, not the length
    const current = screen.getByRole("button", { name: /The Other/ });
    expect(within(current).getByText("5:00")).toBeTruthy(); // the current row keeps its length
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.getAttribute("aria-label") ?? current.textContent).toMatch(/Playing,/);
    expect(within(current).queryByText("Played")).toBeNull();
  });

  it("plays the clicked chapter row even when it is behind the saved position", async () => {
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /One Way/ }));
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
  });

  it("shows Preparing on the primary action until audio starts", async () => {
    prepareStatuses = { s1: "generating" };
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /One Way/ }));
    const preparing = await screen.findByRole("button", { name: "Preparing…" });
    expect(preparing.querySelector("svg")).toBeTruthy(); // the spinner icon
    prepareStatuses = {};
    await act(async () => {
      MockEventSource.instances[0]!.emit("audio", { book_id: ID, segment_id: "s1" });
    });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy());
  });

  it("clears the preparing state when the player errors", async () => {
    prepareStatuses = { s1: "failed" };
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /One Way/ }));
    await screen.findByRole("button", { name: "Preparing…" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Preparing…" })).toBeNull(),
      { timeout: 3000 },
    );
  });

  it("shows the percent and time left on the playing chapter row", async () => {
    stubViewport(true);
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const current = await screen.findByRole("button", { name: /The Other/ });
    expect(within(current).getByText(/50%/)).toBeTruthy();
  });

  it("shows the desktop ⋮ menu next to the primary action", async () => {
    stubViewport(true);
    renderDetail();
    expect(await screen.findByRole("button", { name: "More options for this book" })).toBeTruthy();
  });

  it("hides the Manage tab without can_edit", async () => {
    book = makeBook({ can_edit: false });
    renderDetail();
    await screen.findByRole("tab", { name: "Chapters" });
    expect(screen.queryByRole("tab", { name: "Manage" })).toBeNull();
  });

  it("shows Manage to an uploader with all sections", async () => {
    book = makeBook({ can_edit: true, locked_fields: ["title", "genre"] });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect((await screen.findByRole("link", { name: /Edit details/ })).getAttribute("href")).toBe(`/books/${ID}/edit`);
    expect(screen.getByText(/Cover, title, author, description and other metadata./)).toBeTruthy();
    expect(screen.getByText(/2 fields you edited are protected from automatic updates/)).toBeTruthy();

    // Find metadata lives only inside the drawer (user override).
    expect(screen.queryByRole("link", { name: /Find metadata/ })).toBeNull();

    const toggle = screen.getByRole("switch", { name: "Narrate One Way" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await vi.waitFor(() =>
      expect(chapterPatchBodies).toContainEqual({ excluded: true, chapterId: "c1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reprocess" }));
    await vi.waitFor(() => expect(reprocessCalls).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Delete book" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete .Dune./ });
    expect(within(dialog).getByText(/can’t be undone/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText("at /library")).toBeTruthy();
  });

  it("has no Cover row in Manage — the cover lives in the Edit details drawer", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect(await screen.findByText("Details")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change cover" })).toBeNull();
    expect(screen.queryByText("Upload an image or paste a link, then crop to 2:3.")).toBeNull();
  });

  it("opens the Edit details drawer over the Manage tab at /books/:id/edit and focuses Title", async () => {
    book = makeBook({ can_edit: true });
    renderDetail(`/books/${ID}/edit`);
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    expect(screen.getByRole("tab", { name: "Manage" }).getAttribute("aria-selected")).toBe("true");
    // The page underneath shows the Manage tab.
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete book" })).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Title" }));
  });

  it("closing the drawer lands on the Manage tab of the book page", async () => {
    book = makeBook({ can_edit: true });
    renderDetail(`/books/${ID}/edit`);
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit details" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Manage" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Delete book" })).toBeTruthy();
  });

  it("does not open the drawer for users without can_edit", async () => {
    book = makeBook({ can_edit: false });
    renderDetail(`/books/${ID}/edit`);
    expect(await screen.findByRole("tab", { name: "Chapters" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Edit details" })).toBeNull();
  });

  it("collapses the Manage chapter list to ten with Show all and Show less", async () => {
    book = makeBook({ can_edit: true });
    chapters = Array.from({ length: 17 }, (_, index) => ({
      id: `c${index + 1}`,
      idx: index,
      title: `Chapter ${index + 1}`,
      char_count: 100,
    }));
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect(await screen.findByText("17 of 17 on")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Narrate Chapter 10" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Narrate Chapter 11" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 17" }));
    expect(await screen.findByRole("switch", { name: "Narrate Chapter 17" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("switch", { name: "Narrate Chapter 11" })).toBeNull();
  });

  it("updates the Chapters tab and the on-count when a chapter is excluded", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(screen.getByRole("switch", { name: "Narrate One Way" }));
    expect(await screen.findByText("1 of 2 on")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    // Excluded chapters have no row at all; Manage is where they are re-enabled.
    expect(screen.queryByRole("button", { name: /One Way/ })).toBeNull();
    const remaining = screen.getByRole("button", { name: /The Other/ });
    expect(within(remaining).getByText("1")).toBeTruthy();
  });

  it("restores the previous value and shows an error when excluding fails", async () => {
    book = makeBook({ can_edit: true });
    chapterPatchFails = true;
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    const toggle = screen.getByRole("switch", { name: "Narrate One Way" });
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/nope/));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("2 of 2 on")).toBeTruthy();
  });

  it("numbers included chapters sequentially after excluding a middle chapter", async () => {
    book = makeBook({ can_edit: true });
    chapters = [
      { id: "c1", idx: 0, title: "One", char_count: 300 },
      { id: "c2", idx: 1, title: "Two", char_count: 400 },
      { id: "c3", idx: 2, title: "Three", char_count: 300 },
    ];
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(screen.getByRole("switch", { name: "Narrate Two" }));
    await vi.waitFor(() => expect(screen.getByText("2 of 3 on")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(await screen.findByRole("button", { name: /^1\D*One/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^2\D*Three/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Two/ })).toBeNull();
    expect(screen.getByRole("tabpanel").textContent).not.toContain("Two");
  });

  it("shows an empty state when every chapter is excluded", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(screen.getByRole("switch", { name: "Narrate One Way" }));
    await vi.waitFor(() => expect(screen.getByText("1 of 2 on")).toBeTruthy());
    fireEvent.click(screen.getByRole("switch", { name: "Narrate The Other" }));
    await vi.waitFor(() => expect(screen.getByText("0 of 2 on")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(await screen.findByText("No chapters are set to narrate. Include chapters under Manage.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /One Way|The Other/ })).toBeNull();
  });

  it("shows only populated About rows and links authors, genre and tags to searches", async () => {
    book = makeBook({
      publisher: "Seabed Press",
      isbn13: "9781234567890",
      tags: ["Mystery"],
      description: "A ledger.",
      published_date: "1965",
      genre: "Science Fiction",
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "About" }));
    expect(await screen.findByText("Publisher")).toBeTruthy();
    expect(screen.getByText("Seabed Press")).toBeTruthy();
    expect(screen.getByText("Genre")).toBeTruthy();
    expect(screen.getByText("Science Fiction")).toBeTruthy();
    expect(screen.getByText("1965")).toBeTruthy();
    expect(screen.getByText("9781234567890")).toBeTruthy();
    expect(screen.queryByText("Series")).toBeNull(); // empty rows are hidden
    expect(screen.getByText("A ledger.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mystery" }).getAttribute("href")).toBe("/search?q=Mystery");
    // The author is linked twice: the hero and the About row.
    const authorLinks = screen.getAllByRole("link", { name: "Frank Herbert" });
    expect(authorLinks[0]!.getAttribute("href")).toBe("/search?q=Frank%20Herbert");
  });

  it("shows the narrator in a row under Play, not in the ⋮ menu", async () => {
    book = makeBook({ narrator_voice: "ashley-en", can_edit: true });
    renderDetail();
    const play = await screen.findByRole("button", { name: "Play" });
    const row = await screen.findByRole("button", { name: "Narrator voice, Ashley" });
    expect(row.textContent).toContain("Narrated by Ashley"); // display name, not the id
    // Directly below the primary action.
    expect(play.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await openMore();
    await screen.findByRole("menuitem", { name: "Go to author" });
    expect(screen.queryByRole("menuitem", { name: "Narrator voice" })).toBeNull();
  });

  it("on desktop the narrator is in the ⋮ menu beside Resume, with no row", async () => {
    stubViewport(true);
    book = makeBook({ narrator_voice: "ashley-en", can_edit: true });
    renderDetail();
    await screen.findByRole("button", { name: "Play" });
    expect(screen.queryByRole("button", { name: /^Narrator voice, / })).toBeNull();
    expect(screen.queryByText(/Narrated by/)).toBeNull();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Narrator voice" }));
    const dialog = await screen.findByRole("dialog", { name: "Narrator voice" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Zoe" }));
    await vi.waitFor(() => expect(lastPatchBody()).toEqual({ narrator_voice: "zoe-en" }));
  });

  it("on desktop the narrator reload still runs after the menu's dialog closes", async () => {
    stubViewport(true);
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
    const before = prepareCalls.length;
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Narrator voice" }));
    const dialog = await screen.findByRole("dialog", { name: "Narrator voice" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Zoe" }));
    await vi.waitFor(() => expect(prepareCalls.length).toBeGreaterThan(before));
    expect(prepareCalls.some((call) => call.voice === "zoe-en")).toBe(true);
  });

  it("on desktop listeners who cannot edit get no Narrator voice menu item", async () => {
    stubViewport(true);
    book = makeBook({ can_edit: false });
    renderDetail();
    await openMore();
    await screen.findByRole("menuitem", { name: "Go to author" });
    expect(screen.queryByRole("menuitem", { name: "Narrator voice" })).toBeNull();
  });

  it("falls back to the server default voice for the book's language", async () => {
    book = makeBook({ narrator_voice: null, can_edit: true });
    renderDetail();
    const row = await screen.findByRole("button", { name: "Narrator voice, Zoe" });
    expect(row.textContent).toContain("Narrated by Zoe");
  });

  it("shows the narrator as plain text to listeners who cannot change it", async () => {
    book = makeBook({ narrator_voice: "ashley-en", can_edit: false });
    renderDetail();
    expect(await screen.findByText("Narrated by Ashley")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Narrator voice/ })).toBeNull();
  });

  it("opens the narrator dialog from the row under Play and saves the choice with a PATCH", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    const dialog = await openNarratorDialog();
    // Language voices only, by display name or the parsed fallback.
    await within(dialog).findByRole("button", { name: "Ashley" });
    const zoe = within(dialog).getByRole("button", { name: "Zoe" });
    expect(within(dialog).queryByRole("button", { name: /ashley-ja/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /tts/ })).toBeNull();
    fireEvent.click(zoe);
    expect(screen.queryByRole("dialog", { name: "Narrator voice" })).toBeNull();
    await vi.waitFor(() => expect(lastPatchBody()).toEqual({ narrator_voice: "zoe-en" }));
  });

  it("reloads the active player at the same position when the narrator changes", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
    const before = prepareCalls.length;
    const dialog = await openNarratorDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Zoe" }));
    await vi.waitFor(() => expect(lastPatchBody()).toEqual({ narrator_voice: "zoe-en" }));
    await vi.waitFor(() => expect(prepareCalls.length).toBeGreaterThan(before));
    expect(prepareCalls.some((call) => call.voice === "zoe-en")).toBe(true);
  });

  it("moves focus into the narrator dialog so Escape closes it", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    const dialog = await openNarratorDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Narrator voice" })).toBeNull();
  });

  it("previews a voice from the dialog without selecting it", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    const dialog = await openNarratorDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Preview Ashley" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/voices/preview"));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ voice: "ashley-en" });
    });
    expect(screen.getByRole("dialog", { name: "Narrator voice" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("checks Use my default when the book has no narrator of its own", async () => {
    book = makeBook({ narrator_voice: null, can_edit: true });
    renderDetail();
    const dialog = await openNarratorDialog();
    const useDefault = await within(dialog).findByRole("button", { name: "Use my default for English" });
    expect(useDefault.getAttribute("aria-pressed")).toBe("true");
    expect(useDefault.querySelector("[data-checked]")).toBeTruthy();
  });

  it("marks the saved voice pressed and clears it with Use my default", async () => {
    book = makeBook({ narrator_voice: "ashley-en", can_edit: true });
    renderDetail();
    const dialog = await openNarratorDialog();
    const ashley = await within(dialog).findByRole("button", { name: "Ashley" });
    expect(ashley.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my default for English" }));
    await vi.waitFor(() => expect(lastPatchBody()).toEqual({ narrator_voice: null }));
  });

  it("goes to the author from the ⋮ menu", async () => {
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Go to author" }));
    expect(await screen.findByText("at /search?q=Frank%20Herbert")).toBeTruthy();
  });

  it("opens saved metadata matches in the drawer with the results pane open", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    const review = await screen.findByRole("button", { name: "Review metadata matches" });
    fireEvent.click(review);
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    const pane = within(dialog).getByRole("region", { name: "Find metadata" });
    expect(within(pane).getByRole("button", { name: /72%/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Use 1965" })).toBeTruthy();
  });

  it("uses a suggestion and saves from inside the drawer", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Review metadata matches" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use 1965" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}`) && init?.method === "PATCH");
      expect(String(call?.[1]?.body)).toContain('"metadata_fields":["published_date"]');
    });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit details" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Manage" }).getAttribute("aria-selected")).toBe("true");
  });

  it("hides the banner when there are no candidates", async () => {
    candidates = [];
    renderDetail();
    expect(await screen.findByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review metadata matches" })).toBeNull();
  });

  it("adds a pronunciation rule from the Manage tab", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "New match" }), { target: { value: "Leto" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New say" }), { target: { value: "Lee-toh" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation`) && init?.method === "POST");
      expect(call).toBeTruthy();
    });
    expect((await screen.findByRole("textbox", { name: "Match 1" }) as HTMLInputElement).value).toBe("Leto");
  });

  it("edits and removes a pronunciation rule from the Manage tab", async () => {
    book = makeBook({ can_edit: true });
    rules = [makeRule()];
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "case sensitive 1" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation/r1`) && init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ case_sensitive: true });
    });
    expect(rules[0]?.case_sensitive).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove rule 1" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation/r1`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
  });

  it("renders the desktop meta line as Book · language · length · chapters", async () => {
    stubViewport(true);
    book = makeBook({ narrator_voice: "ashley-en" });
    renderDetail();
    expect(await screen.findByText("Book · English · 10 m · 2 chapters")).toBeTruthy();
    // The narrator is not part of the meta line any more.
    expect(screen.queryByText(/narrated by/)).toBeNull();
  });

  it("expands the description inline with More", async () => {
    stubViewport(true);
    book = makeBook({ description: `${"A long ledger. ".repeat(20)}` });
    renderDetail();
    const more = await screen.findByRole("button", { name: "More" });
    expect(more).toBeTruthy();
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Less" })).toBeTruthy();
  });

  it("splits into the same columns as the player page so the cover never moves", async () => {
    stubViewport(true);
    renderDetail();
    await screen.findByRole("button", { name: /Play|Resume/ });
    const grid = document.querySelector('[class*="340px_minmax"]');
    expect(grid?.className).toContain("lg:grid-cols-[340px_minmax(0,1fr)]");
    expect(grid?.className).toContain("gap-12");
    expect(grid?.className).toContain("pt-6");
  });

  it("renders the phone layout: back + ⋮ header, centered cover, meta with percent", async () => {
    progress = makeProgress({ percent: 38, chapter_id: "c2", segment_id: "s3" });
    renderDetail();
    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More options for this book" })).toBeTruthy();
    expect(screen.getByText("10 m · 2 chapters · 38% listened")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });
});
