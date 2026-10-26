import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import { AuthProvider } from "../auth/AuthProvider";
import { PlayerProvider } from "../player/PlayerProvider";
import {
  BOOK_ID,
  CH1,
  CH2,
  installPlayerFetch,
  makeBook,
  makeProgress,
  stubMedia,
} from "../test/player";
import type { Book } from "../api/types";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function shelfBook(overrides: Partial<Book> = {}): Book {
  return {
    ...makeBook(),
    id: "99999999-9999-9999-9999-999999999999",
    title: "The Time Machine",
    authors: ["H. G. Wells"],
    est_duration_s: 12720,
    ...overrides,
  };
}

/** Body of GET /books?group=genre: deliberately not in count order, so the
 * test proves Home sorts (count desc, "No genre yet" last). */
const GENRES = [
  {
    key: "Fantasy",
    label: "Fantasy",
    count: 3,
    books: [shelfBook({ id: "66666666-0000-0000-0000-000000000001", title: "A Wizard of Earthsea", genre: "Fantasy" })],
  },
  {
    key: "Mystery",
    label: "Mystery",
    count: 5,
    books: [shelfBook({ id: "66666666-0000-0000-0000-000000000002", title: "The Long Goodbye", genre: "Mystery" })],
  },
  {
    key: null,
    label: "No genre yet",
    count: 1,
    books: [shelfBook({ id: "66666666-0000-0000-0000-000000000003", title: "Untitled Ledger", genre: null })],
  },
];

const HOME = {
  continue: [
    {
      book: makeBook(),
      progress: makeProgress({ percent: 38, chapter_id: CH1 }),
      // idx 4 with earlier chapters excluded: the card must show the included
      // position (2), not the source index (5).
      chapter: { id: CH1, idx: 4, number: 2, title: "Lamp Oil" },
      time_left_s: 9360,
    },
  ],
  next_chapters: [
    // idx 5 with earlier chapters excluded: the card must show the included
    // position (2), not the source index (6).
    { book: makeBook(), chapter: { id: CH2, idx: 5, number: 2, title: "The Keeper", duration_s: 1080 } },
  ],
  recent: [shelfBook()],
};

function mockHome(home: typeof HOME = HOME, groups: unknown = GENRES): void {
  installPlayerFetch();
  const base = vi.mocked(fetch);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return jsonResponse({
          user: { id: "u1", username: "browser", display_name: "Browser User", email: null, role: "user" },
          csrf_token: "t",
        });
      }
      if (url.includes("/me/home")) return jsonResponse(home);
      if (url.includes("/books?")) return jsonResponse({ groups });
      if (url.includes("/me/continue") || url.includes("/me/finished")) {
        return jsonResponse({ items: [] });
      }
      return base(input, init);
    }),
  );
}

function renderHome(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <PlayerProvider>
            <HomePage />
          </PlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HomePage", () => {
  it("renders the three shelves with the reference copy", async () => {
    mockHome();
    renderHome();
    const continueShelf = await screen.findByRole("region", { name: "Continue listening" });
    expect(within(continueShelf).getByText("Browser User")).toBeTruthy();
    expect(within(continueShelf).getByText("Ch. 2 · 2 h 36 m left")).toBeTruthy();

    const next = await screen.findByRole("region", { name: "Next chapters" });
    expect(within(next).getByText("2 · The Keeper")).toBeTruthy();
    expect(within(next).getByText("Dune · 18 min")).toBeTruthy();
    expect(within(next).getByRole("button", { name: "Play next" })).toBeTruthy();

    const recent = await screen.findByRole("region", { name: "Recently added" });
    expect(within(recent).getByText("H. G. Wells · 3 h 32 m")).toBeTruthy();
    expect(within(recent).getByRole("link", { name: "See all" }).getAttribute("href")).toBe(
      "/library?sort=recent&group=none",
    );
  });

  it("refetches the shelves with the chip filters", async () => {
    mockHome();
    renderHome();
    const group = await screen.findByRole("group", { name: "Filter" });
    fireEvent.click(within(group).getByRole("button", { name: "In progress" }));
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("/me/home?status=in_progress"));
      expect(call).toBeTruthy();
    });
    fireEvent.click(within(group).getByRole("button", { name: "Under 3 hours" }));
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("max_minutes=180"));
      expect(call).toBeTruthy();
    });
    fireEvent.click(within(group).getByRole("button", { name: "All" }));
    expect(
      within(group)
        .getByRole("button", { name: "All" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows one language chip per language present", async () => {
    mockHome({ ...HOME, recent: [shelfBook(), shelfBook({ id: "88888888-0000-0000-0000-000000000000", language: "ja" })] });
    renderHome();
    const group = await screen.findByRole("group", { name: "Filter" });
    expect(await within(group).findByRole("button", { name: "日本語" })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "日本語" }));
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("/me/home?language=ja"));
      expect(call).toBeTruthy();
    });
  });

  it("resumes playback when a Continue card is clicked, without navigating", async () => {
    stubMedia();
    mockHome();
    renderHome();
    const shelf = await screen.findByRole("region", { name: "Continue listening" });
    const card = within(shelf).getByRole("link", { name: "Dune, 38% listened, resume" });
    expect(card.getAttribute("href")).toBe(`/player?book=${BOOK_ID}&chapter=${CH1}`);
    fireEvent.click(card);
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes(`/books/${BOOK_ID}/chapters/${CH1}/segments`));
      expect(call).toBeTruthy();
    });
    // Still on Home: the shelves remain rendered and nothing navigated.
    expect(screen.getByRole("region", { name: "Next chapters" })).toBeTruthy();
  });

  it("starts the first row from Play next", async () => {
    stubMedia();
    mockHome();
    renderHome();
    const next = await screen.findByRole("region", { name: "Next chapters" });
    fireEvent.click(within(next).getByRole("button", { name: "Play next" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).includes("/audio/prepare"));
      expect(call).toBeTruthy();
    });
  });

  it("shows the empty state when every shelf is empty", async () => {
    mockHome({ continue: [], next_chapters: [], recent: [] });
    renderHome();
    expect(await screen.findByRole("heading", { name: "Your library is empty" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload books" })).toBeTruthy();
  });

  it("adds genre shelves sorted by count with No genre yet last", async () => {
    mockHome();
    renderHome();
    const block = await screen.findByRole("region", { name: "Browse by genre" });
    expect(
      [...block.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label")),
    ).toEqual(["Mystery", "Fantasy", "No genre yet"]);
    expect(within(block).getByText("Mystery")).toBeTruthy();
    expect(
      within(block)
        .getAllByRole("link", { name: "See all" })
        .map((l) => l.getAttribute("href")),
    ).toEqual([
      "/library?group=none&genre=Mystery",
      "/library?group=none&genre=Fantasy",
      "/library?group=none&genre=none",
    ]);
  });

  it("sends the status chip to the grouped genre query", async () => {
    mockHome();
    renderHome();
    const group = await screen.findByRole("group", { name: "Filter" });
    await screen.findByRole("region", { name: "Browse by genre" });
    fireEvent.click(within(group).getByRole("button", { name: "In progress" }));
    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => {
          const u = new URL(String(url), "http://localhost");
          return (
            u.pathname.endsWith("/books") &&
            u.searchParams.get("group") === "genre" &&
            u.searchParams.get("status") === "in_progress"
          );
        });
      expect(call).toBeTruthy();
    });
  });

  it("filters the genre shelves with the language and duration chips", async () => {
    const japanese = shelfBook({
      id: "77777777-0000-0000-0000-000000000001",
      title: "Sangetsuki",
      language: "ja",
      genre: "Fantasy",
    });
    mockHome(
      { ...HOME, recent: [shelfBook(), japanese] },
      [
        {
          key: "Fantasy",
          label: "Fantasy",
          count: 2,
          books: [
            shelfBook({ id: "66666666-0000-0000-0000-000000000001", title: "The Long Goodbye", genre: "Fantasy" }),
            japanese,
          ],
        },
        {
          key: "Mystery",
          label: "Mystery",
          count: 1,
          books: [
            shelfBook({
              id: "66666666-0000-0000-0000-000000000002",
              title: "The Hobbit",
              genre: "Mystery",
              est_duration_s: 600,
            }),
          ],
        },
      ],
    );
    renderHome();
    await screen.findByRole("region", { name: "Browse by genre" });
    const filter = await screen.findByRole("group", { name: "Filter" });

    fireEvent.click(within(filter).getByRole("button", { name: "日本語" }));
    await waitFor(() => {
      const fantasy = screen.getByRole("region", { name: "Fantasy" });
      expect(within(fantasy).getByText("Sangetsuki")).toBeTruthy();
      expect(within(fantasy).queryByText("The Long Goodbye")).toBeNull();
      expect(screen.queryByRole("region", { name: "Mystery" })).toBeNull();
    });

    fireEvent.click(within(filter).getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Mystery" })).toBeTruthy();
    });

    // "Under 3 hours" drops the 3 h 32 m books, and with them the empty shelf.
    fireEvent.click(within(filter).getByRole("button", { name: "Under 3 hours" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Fantasy" })).toBeNull();
      expect(
        within(screen.getByRole("region", { name: "Mystery" })).getByText("The Hobbit"),
      ).toBeTruthy();
    });
  });

  it("hides the genre block when the listing has no groups", async () => {
    mockHome(HOME, []);
    renderHome();
    await screen.findByRole("region", { name: "Recently added" });
    expect(screen.queryByRole("region", { name: "Browse by genre" })).toBeNull();
  });
});
