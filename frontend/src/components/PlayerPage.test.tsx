import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, CH2, installPlayerFetch, renderPlayer, stubMedia } from "../test/player";
import { PlayerPage } from "./PlayerPage";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

async function renderAtPlayer(): Promise<() => import("../player/usePlayer").PlayerContextValue> {
  const getPlayer = renderPlayer(<PlayerPage />, [`/player?book=${BOOK_ID}&chapter=${CH1}`]);
  await waitFor(() => expect(getPlayer().book).toBeTruthy());
  return getPlayer;
}

beforeEach(() => {
  localStorage.clear();
  installMockEventSource();
  installPlayerFetch();
  stubMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlayerPage (desktop)", () => {
  it("shows the tabs with Read along selected and lyrics-style sentences", async () => {
    const getPlayer = await renderAtPlayer();
    act(() => {
      getPlayer().seekChapter(15); // segment 1, middle → past/current/next all present
    });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Up next", "Read along", "About"]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");

    const current = await waitFor(() => {
      const node = document.querySelector('[aria-current="true"]');
      expect(node).toBeTruthy();
      return node!;
    });
    expect(current.className).toContain("ra-current");
    expect(current.getAttribute("style")).toContain("font-size: 26px"); // 22px body + 4
    const past = document.querySelector(".ra-past");
    const next = document.querySelector(".ra-next");
    expect(past?.textContent).toContain(`One ${CH1}-seg0 here`);
    expect(next?.textContent).toContain(`Three ${CH1}-seg1 here`);
  });

  it("Up next lists the remaining chapters and clicking one plays it", async () => {
    const getPlayer = await renderAtPlayer();
    fireEvent.click(screen.getByRole("tab", { name: "Up next" }));
    const panel = screen.getByRole("tabpanel");
    const row = within(panel).getByRole("button", { name: /Chapter Two/ });
    expect(within(row).getByText("2")).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
  });

  it("About shows the book and links to the book page", async () => {
    await renderAtPlayer();
    fireEvent.click(screen.getByRole("tab", { name: "About" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Dune")).toBeTruthy();
    expect(within(panel).getByText("Frank Herbert")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Open book" }).getAttribute("href")).toBe(`/books/${BOOK_ID}`);
  });

  it("the large cover links to the book page", async () => {
    await renderAtPlayer();
    expect(screen.getByRole("link", { name: "Open Dune" }).getAttribute("href")).toBe(`/books/${BOOK_ID}`);
  });

  it("leaves no side panel or focus-mode remnants", async () => {
    await renderAtPlayer();
    expect(screen.queryByRole("complementary", { name: "Now playing" })).toBeNull();
    expect(screen.queryByRole("button", { name: /focus/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse player to a bar" })).toBeNull();
  });

  it("shows an empty state when nothing is loaded", () => {
    renderPlayer(<PlayerPage />, ["/player"]);
    expect(screen.getByText("Nothing to play")).toBeTruthy();
  });

  it("splits into the same columns as the book page so the cover never moves", async () => {
    await renderAtPlayer();
    const grid = document.querySelector('[class*="340px_minmax"]');
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain("gap-12");
    expect(grid?.className).toContain("pt-6");
  });

  it("has exactly one scroll container per tab and never scrolls the document", async () => {
    await renderAtPlayer();
    const viewport = document.querySelector('[class*="overflow-hidden"][class*="h-full"]');
    expect(viewport).toBeTruthy(); // the player owns the viewport box
    const panel = screen.getByRole("tabpanel");
    expect(panel.className).toContain("overflow-hidden"); // the read panel itself never scrolls
    expect(panel.className).not.toContain("overflow-y-auto");
    const box = document.querySelector('article[aria-label="Read along"]')!;
    expect(box.className).toContain("min-h-0");
    expect(box.className).toContain("flex-1");
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className).toContain("scroll-thin");
    expect(document.querySelectorAll('[class*="overflow-y-auto"]').length).toBe(1);

    fireEvent.click(screen.getByRole("tab", { name: "Up next" }));
    const nextPanel = screen.getByRole("tabpanel");
    expect(nextPanel.className).toContain("overflow-y-auto");
    expect(nextPanel.className).toContain("scroll-thin");
    expect(document.querySelectorAll('[class*="overflow-y-auto"]').length).toBe(1);
  });

  it("the follow effect scrolls the read-along panel itself", async () => {
    const getPlayer = await renderAtPlayer();
    const box = document.querySelector<HTMLElement>('article[aria-label="Read along"]')!;
    let scrollTop = 0;
    Object.defineProperty(box, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 400 });
    for (const node of box.querySelectorAll("p")) {
      Object.defineProperty(node, "offsetTop", { configurable: true, get: () => 900 });
    }
    act(() => {
      getPlayer().seekChapter(15); // segment change triggers the follow
    });
    await waitFor(() => expect(scrollTop).toBeGreaterThan(0));
    await waitFor(() => expect(scrollTop).toBeCloseTo(900 - 400 / 3, 0));
  });
});

describe("PlayerPage (phone)", () => {
  it("renders the full-screen player with the 72px play button", async () => {
    stubMatchMedia(false);
    const getPlayer = await renderAtPlayer();
    expect(screen.getByRole("button", { name: "Close player" })).toBeTruthy();
    expect(screen.getByText("Now playing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(screen.getByTestId("player-elapsed")).toBeTruthy();
  });

  it("the 236 px cover links to the book page", async () => {
    stubMatchMedia(false);
    await renderAtPlayer();
    expect(screen.getByRole("link", { name: "Open Dune" }).getAttribute("href")).toBe(`/books/${BOOK_ID}`);
  });

  it("the speed card opens centered in a bottom sheet above the controls", async () => {
    stubMatchMedia(false);
    await renderAtPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.0 times" }));
    const dialog = await screen.findByRole("dialog", { name: "Playback speed" });
    const sheet = dialog.parentElement!; // fixed bottom sheet, card centered in it
    expect(sheet.className).toContain("fixed");
    expect(sheet.className).toContain("inset-x-0");
    expect(sheet.className).toContain("bottom-0");
    expect(sheet.className).toContain("justify-center");
    expect(within(dialog).getByRole("slider", { name: "Playback speed" })).toBeTruthy();
  });

  it("the Read along tab opens the sheet with pinned controls", async () => {
    stubMatchMedia(false);
    await renderAtPlayer();
    fireEvent.click(screen.getByRole("tab", { name: "Read along" }));
    const playback = await screen.findByRole("region", { name: "Playback" });
    expect(within(playback).getByRole("button", { name: "Play" })).toBeTruthy();
    const toggle = within(playback).getByRole("button", { name: "Auto-scroll" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(playback).getByRole("button", { name: "Back 15 seconds" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to player" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toBe("Aa");
    expect(screen.queryByRole("button", { name: /^Increase font size/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Decrease font size/ })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    // The sheet's Aa control is the same five-step picker.
    fireEvent.click(screen.getByRole("button", { name: "Text size" }));
    fireEvent.click(screen.getByRole("radio", { name: "Huge" }));
    const box = document.querySelector('article[aria-label="Read along"]')!;
    expect((box.firstElementChild as HTMLElement).getAttribute("style")).toContain("font-size: 28px");

    fireEvent.click(screen.getByRole("button", { name: "Back to player" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Playback" })).toBeNull());
  });

  it("the Up next tab lists the remaining chapters in a sheet", async () => {
    stubMatchMedia(false);
    await renderAtPlayer();
    fireEvent.click(screen.getByRole("tab", { name: "Up next" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("button", { name: /Chapter Two/ })).toBeTruthy();
  });

  it("⋮ stops and unloads the book", async () => {
    stubMatchMedia(false);
    const getPlayer = await renderAtPlayer();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop and close" }));
    await waitFor(() => expect(getPlayer().book).toBeNull());
    expect(screen.getByText("Nothing to play")).toBeTruthy();
  });
});
