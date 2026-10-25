import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { BookDetailPage } from "./BookDetailPage";
import { PlayerProvider } from "../player/PlayerProvider";
import { installMockEventSource } from "../test/eventsource";
import { makeProgress } from "../test/player";
import { DEFAULT_SETTINGS } from "../api/settings";
import type { PronunciationRule } from "../api/pronunciation";
import type { Book, Candidate, Chapter, Progress, Role } from "../api/types";

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

beforeEach(() => {
  candidates = [CANDIDATE];
  book = makeBook();
  chapters = CHAPTERS;
  progress = null;
  role = "user";
  rules = [];
  rulesFail = false;
  ruleSeq = 1;
  localStorage.clear();
  installMockEventSource();
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
        const { excluded } = body as { excluded: boolean };
        chapters = chapters.map((chapter) => (chapter.id === chapterPatch[1] ? { ...chapter, excluded } : chapter));
        return jsonResponse(200, { chapter: chapters.find((chapter) => chapter.id === chapterPatch[1]) });
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
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      if (url.includes(`/books/${ID}/progress/finished`) && method === "PUT") {
        const { finished } = body as { finished: boolean };
        progress = makeProgress({ finished_at: finished ? "2026-01-03T00:00:00Z" : null });
        return jsonResponse(200, { progress });
      }
      if (url.includes(`/books/${ID}/progress`)) {
        if (method === "DELETE") {
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
              <Route path="/books/:id" element={<BookDetailPage />} />
              <Route path="/player" element={<WhereAmI />} />
            </Routes>
          </AuthProvider>
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the admin "Book settings" disclosure. */
async function openSettings() {
  fireEvent.click(await screen.findByRole("button", { name: /Book settings/ }));
}

/** Open the "More actions" overflow menu. */
async function openMore() {
  fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
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

  it("puts a Play overlay on the cover linking to the player with the first chapter", async () => {
    renderDetail();
    const play = await screen.findByRole("link", { name: "Play" });
    expect(play.getAttribute("href")).toBe(`/player?book=${ID}&chapter=c1`);
    expect(play.querySelector("svg")).toBeTruthy();
  });

  it("has no fixed bottom play/progress bar", async () => {
    renderDetail();
    await screen.findByRole("link", { name: "Play" });
    expect(screen.queryByTestId("book-actions")).toBeNull();
    expect(document.querySelector("div.fixed")).toBeNull();
  });

  it("disables the Play overlay with no playable chapters", async () => {
    chapters = [];
    renderDetail();
    const play = await screen.findByRole("button", { name: "Play" });
    expect((play as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a percent badge on the cover when progress exists", async () => {
    progress = makeProgress({ percent: 24, chapter_id: "c2" });
    renderDetail();
    const badge = await screen.findByText("24%");
    expect(badge.className).toContain("absolute");
    expect(screen.getByRole("link", { name: "Play" }).getAttribute("href")).toBe(`/player?book=${ID}&chapter=c2`);
  });

  it("saves the narrator voice override as the only patched field", async () => {
    renderDetail();
    await screen.findByRole("option", { name: "ashley-en" });
    const select = screen.getByRole("combobox", { name: "en voice" });
    fireEvent.change(select, { target: { value: "ashley-en" } });
    await vi.waitFor(() => {
      const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ narrator_voice: "ashley-en" });
    });
    expect(await screen.findByText(/about 10m/)).toBeTruthy();
  });

  it("navigates to the chosen chapter in the player from the chapter dropdown", async () => {
    renderDetail();
    const select = await screen.findByRole("combobox", { name: "Chapters" });
    expect(within(select).getByRole("option", { name: "2 · The Other · 500 chars" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "c2" } });
    expect(await screen.findByText(`at /player?book=${ID}&chapter=c2`)).toBeTruthy();
  });

  it("steps to the next and previous chapter with the arrow buttons", async () => {
    renderDetail();
    await screen.findByRole("combobox", { name: "Chapters" });
    expect((screen.getByRole("button", { name: "Previous chapter" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    expect(await screen.findByText(`at /player?book=${ID}&chapter=c2`)).toBeTruthy();
  });

  it("marks finished and back with the finished flag in the body", async () => {
    progress = makeProgress({ percent: 40 });
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark finished" }));
    await screen.findByText("Finished");
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([, init]) => String(init?.body ?? "").includes('"finished":true'));
      expect(call).toBeTruthy();
    });
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unfinished" }));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([, init]) => String(init?.body ?? "").includes('"finished":false'));
      expect(call).toBeTruthy();
    });
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("hides the Book settings panel from non-admins", async () => {
    renderDetail();
    await screen.findByRole("link", { name: "Edit" });
    expect(screen.queryByRole("button", { name: /Book settings/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the Book settings panel to admins with chapter switches", async () => {
    role = "admin";
    renderDetail();
    await openSettings();
    expect(await screen.findByRole("switch", { name: "Include One Way in playback" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Include The Other in playback" })).toBeTruthy();
  });

  it("excludes a chapter with PATCH and re-enables it from the Excluded group", async () => {
    role = "admin";
    renderDetail();
    await openSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "Include The Other in playback" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/chapters/c2`) && init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ excluded: true });
    });
    expect(await screen.findByRole("button", { name: /Excluded \(1\)/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Excluded \(1\)/ }));
    const reenable = await screen.findByRole("switch", { name: "Include The Other in playback" });
    expect(reenable.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(reenable);
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) => String(url).includes(`/books/${ID}/chapters/c2`) && String(init?.body ?? "").includes('"excluded":false'),
        );
      expect(call).toBeTruthy();
    });
    expect(await screen.findByRole("switch", { name: "Include The Other in playback" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Excluded \(\d+\)/ })).toBeNull();
  });

  it("adds a pronunciation rule and shows the Saved state", async () => {
    role = "admin";
    renderDetail();
    await openSettings();
    fireEvent.change(await screen.findByRole("textbox", { name: "New match" }), { target: { value: "Leto" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New say" }), { target: { value: "Lee-toh" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation`) && init?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ match: "Leto", say: "Lee-toh" });
    });
    expect((await screen.findByRole("textbox", { name: "Match 1" }) as HTMLInputElement).value).toBe("Leto");
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("rejects an empty or duplicate match without posting", async () => {
    role = "admin";
    rules = [makeRule()];
    renderDetail();
    await openSettings();
    fireEvent.change(await screen.findByRole("textbox", { name: "New match" }), { target: { value: "leto" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists/i);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("edits a rule flag with a PATCH", async () => {
    role = "admin";
    rules = [makeRule()];
    renderDetail();
    await openSettings();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Case-sensitive 1" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation/r1`) && init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ case_sensitive: true });
    });
    expect(rules[0]?.case_sensitive).toBe(true);
  });

  it("deletes a rule", async () => {
    role = "admin";
    rules = [makeRule()];
    renderDetail();
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Remove rule 1" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/pronunciation/r1`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText("No rules yet.")).toBeTruthy();
  });

  it("reverts an optimistic rule edit when the PATCH fails", async () => {
    role = "admin";
    rules = [makeRule()];
    rulesFail = true;
    renderDetail();
    await openSettings();
    const checkbox = (await screen.findByRole("checkbox", { name: "Case-sensitive 1" })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect((screen.getByRole("checkbox", { name: "Case-sensitive 1" }) as HTMLInputElement).checked).toBe(false);
  });

  it("requires confirmation before resetting progress, then starts at chapter 1", async () => {
    progress = makeProgress({ percent: 40, chapter_id: "c2" });
    localStorage.setItem(`folio-pos-${ID}`, JSON.stringify(makeProgress({ percent: 40 })));
    renderDetail();
    await openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset listening progress" });
    expect(within(dialog).getByText("This cannot be undone.")).toBeTruthy();

    // Cancel does not delete anything.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await screen.findByRole("link", { name: "Play" });
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => init?.method === "DELETE" && String(url).includes("/progress"))).toBe(false);

    // Confirm deletes, clears the local position and starts the player at chapter 1.
    await openMore();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset progress" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes(`/books/${ID}/progress`) && init?.method === "DELETE");
      expect(call).toBeTruthy();
    });
    expect(localStorage.getItem(`folio-pos-${ID}`)).toBeNull();
    expect(await screen.findByText(`at /player?book=${ID}&chapter=c1`)).toBeTruthy();
  });
});
