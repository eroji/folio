import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { BookDetailPage } from "./BookDetailPage";
import { PlayerProvider } from "../player/PlayerProvider";
import { installMockEventSource } from "../test/eventsource";
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
let role: Role = "user";
let rules: PronunciationRule[] = [];
let rulesFail = false;
let ruleSeq = 1;
let prepareCalls: { segment_id: string }[] = [];
let finishedCalls: { finished: boolean }[] = [];
let saveCalls: Record<string, unknown>[] = [];
let chapterPatchBodies: Record<string, unknown>[] = [];
let chapterPatchFails = false;
let reprocessCalls = 0;

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
  localStorage.clear();
  installMockEventSource();
  stubMedia();
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
          if (!rule) return jsonResponse(404, { error: { code: "nope", message: "nope" } });
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
        const prepare = body as { segment_id: string; count: number };
        prepareCalls.push(prepare);
        const all = Object.values(SEGMENTS).flat();
        const from = Math.max(0, all.findIndex((segment) => segment.id === prepare.segment_id));
        return jsonResponse(200, {
          items: all.slice(from, from + prepare.count).map((segment) => ({
            segment_id: segment.id,
            status: "ready",
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
      if (url.includes("/metadata/apply") && method === "POST") {
        return jsonResponse(200, { book, applied: (body.fields as string[]) ?? [] });
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

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/books/${ID}`]}>
        <PlayerProvider>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<WhereAmI />} />
              <Route path="/books/:id" element={<BookDetailPage />} />
              <Route path="/player" element={<WhereAmI />} />
            </Routes>
          </AuthProvider>
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Render at the desktop breakpoint (≥1050px) instead of the phone default. */
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

describe("BookDetailPage", () => {
  it("plays from the start when the book was never started", async () => {
    renderDetail();
    const play = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(play);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
    expect(await screen.findByRole("button", { name: "Playing now" })).toBeTruthy();
  });

  it("shows Resume when progress exists and plays from the saved chapter", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const resume = await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s3")).toBe(true));
  });

  it("turns the primary action into Playing now and opens the phone player from it", async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    const now = await screen.findByRole("button", { name: "Playing now" });
    fireEvent.click(now);
    expect(await screen.findByText(new RegExp(`at /player\\?book=${ID}`))).toBeTruthy();
  });

  it("disables the primary action for a failed book", async () => {
    book = makeBook({ status: "failed", error: "Could not extract text." });
    renderDetail();
    const play = (await screen.findByRole("button", { name: "Play" })) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/Could not extract text/);
  });

  it("shows a percent badge on the cover and names the state on the cover", async () => {
    progress = makeProgress({ percent: 38, chapter_id: "c2", segment_id: "s3" });
    renderDetail();
    const badge = await screen.findByText("38%");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("img", { name: "Dune, 38% listened" })).toBeTruthy();
  });

  it("shows a check badge and no percent when the book is finished", async () => {
    progress = makeProgress({ percent: 100, chapter_id: "c2", segment_id: "s4", finished_at: "2026-01-03T00:00:00Z" });
    renderDetail();
    expect(await screen.findByRole("img", { name: "Dune, finished" })).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /One Way/ })).getByText("Played")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /The Other/ })).getByText("Played")).toBeTruthy();
  });

  it("marks finished from the menu, shows the undo toast, and undo unmarks", async () => {
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
    const dialog = await screen.findByRole("dialog", { name: "Reset listening progress" });
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

  it("marks chapters before the saved position as played and the saved one as current", async () => {
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const played = await screen.findByRole("button", { name: /One Way/ });
    expect(within(played).getByText("Played")).toBeTruthy();
    expect(played.querySelector("svg")).toBeTruthy(); // the check icon
    const current = screen.getByRole("button", { name: /The Other/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.getAttribute("aria-current")).toBeTruthy();
    expect(within(current).queryByText("Played")).toBeNull();
  });

  it("plays the clicked chapter row even when it is behind the saved position", async () => {
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /One Way/ }));
    await vi.waitFor(() => expect(prepareCalls.some((call) => call.segment_id === "s1")).toBe(true));
  });

  it("shows the chapter percent on the current row on desktop", async () => {
    stubViewport(true);
    progress = makeProgress({ percent: 75, chapter_id: "c2", segment_id: "s4" });
    renderDetail();
    const current = await screen.findByRole("button", { name: /The Other/ });
    expect(within(current).getByText("50%")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Library" })).toBeTruthy();
  });

  it("shows the desktop ⋯ menu next to the primary action", async () => {
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

  it("shows Manage to an uploader with all actions", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect((await screen.findByRole("link", { name: "Edit details" })).getAttribute("href")).toBe(`/books/${ID}/edit`);
    expect(screen.getByText(/protected from automatic updates/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Find metadata" }));
    expect(await screen.findByRole("button", { name: "Search" })).toBeTruthy();

    const checkbox = screen.getByRole("checkbox", { name: /One Way/ });
    expect(checkbox.getAttribute("checked")).not.toBeNull();
    fireEvent.click(checkbox);
    await vi.waitFor(() =>
      expect(chapterPatchBodies).toContainEqual({ excluded: true, chapterId: "c1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reprocess book" }));
    await vi.waitFor(() => expect(reprocessCalls).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Delete book" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete .Dune./ });
    expect(within(dialog).getByText(/can’t be undone/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText("at /")).toBeTruthy();
  });

  it("collapses the chapter list to fifteen with Show all and Show less", async () => {
    book = makeBook({ can_edit: true });
    chapters = Array.from({ length: 17 }, (_, index) => ({
      id: `c${index + 1}`,
      idx: index,
      title: `Chapter ${index + 1}`,
      char_count: 100,
    }));
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect(await screen.findByText("17 of 17 included")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Chapter 16/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 17" }));
    expect(await screen.findByRole("checkbox", { name: /Chapter 17/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("checkbox", { name: /Chapter 16/ })).toBeNull();
  });

  it("updates the Chapters tab and the included count when a chapter is excluded", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /One Way/ }));
    expect(await screen.findByText("1 of 2 included")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(screen.getByTitle("Excluded from narration")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /One Way/ })).toBeNull();
    expect(screen.getByRole("button", { name: /The Other/ })).toBeTruthy();
  });

  it("restores the previous value and shows an error when excluding fails", async () => {
    book = makeBook({ can_edit: true });
    chapterPatchFails = true;
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    const checkbox = screen.getByRole("checkbox", { name: /One Way/ }) as HTMLInputElement;
    fireEvent.click(checkbox);
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/nope/));
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText("2 of 2 included")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
    await vi.waitFor(() => expect(screen.getByText("2 of 3 included")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(await screen.findByRole("button", { name: /^1\D*One/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^2\D*Three/ })).toBeTruthy();
    expect(screen.getByTitle("Excluded from narration").textContent).toContain("Two");
  });

  it("shows only populated About rows and links authors and tags to searches", async () => {
    book = makeBook({ publisher: "Seabed Press", isbn13: "9781234567890", tags: ["Mystery"], description: "A ledger.", published_date: "1965" });
    renderDetail();
    fireEvent.click(await screen.findByRole("tab", { name: "About" }));
    expect(await screen.findByText("Publisher")).toBeTruthy();
    expect(screen.getByText("Seabed Press")).toBeTruthy();
    expect(screen.getByText("1965")).toBeTruthy();
    expect(screen.getByText("9781234567890")).toBeTruthy();
    expect(screen.queryByText("Series")).toBeNull();
    expect(screen.getByText("A ledger.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mystery" }).getAttribute("href")).toBe("/?q=Mystery");
    expect(screen.getByRole("link", { name: "Frank Herbert" }).getAttribute("href")).toBe("/?q=Frank%20Herbert");
  });

  it("opens the narrator voice picker from the voice button and saves the choice", async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /Narrator voice/ }));
    await screen.findByRole("option", { name: "ashley-en" });
    const select = screen.getByRole("combobox", { name: "en voice" });
    fireEvent.change(select, { target: { value: "ashley-en" } });
    await vi.waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ narrator_voice: "ashley-en" });
    });
  });

  it("shows the review banner and opens Find metadata in the Manage tab", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    const review = await screen.findByRole("button", { name: "Review metadata matches" });
    fireEvent.click(review);
    expect(screen.getByRole("tab", { name: "Manage" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("button", { name: "Apply selected" })).toBeTruthy();
    expect(screen.getByText(/72% match/)).toBeTruthy();
  });

  it("applies metadata and renders no search panel outside the Manage tab", async () => {
    book = makeBook({ can_edit: true });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Review metadata matches" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply selected" }));
    await screen.findByText(/Applied:/);
    fireEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "ISBN" })).toBeNull();
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
    fireEvent.click(await screen.findByRole("checkbox", { name: "Case-sensitive 1" }));
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

  it("renders the hero meta line with language, length, chapters and narrator on desktop", async () => {
    stubViewport(true);
    book = makeBook({ narrator_voice: "ashley-en" });
    renderDetail();
    expect(await screen.findByText("English · 10 m · 2 chapters · narrated by ashley-en")).toBeTruthy();
  });
});
