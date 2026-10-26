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
    expect(current.getAttribute("style")).toContain("font-size: 26px"); // larger than the 22px base
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

  it("scrolls the panes internally instead of the window", async () => {
    await renderAtPlayer();
    const pane = screen.getByRole("tabpanel");
    expect(pane.className).toContain("overflow-y-auto");
    expect(pane.className).toContain("scroll-thin");
    expect(pane.getAttribute("style")).toContain("min(560px");
    const box = document.querySelector('article[aria-label="Read along"]')!;
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className).toContain("scroll-thin");
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

  it("the Read along tab opens the sheet with pinned controls", async () => {
    stubMatchMedia(false);
    await renderAtPlayer();
    fireEvent.click(screen.getByRole("tab", { name: "Read along" }));
    const playback = await screen.findByRole("region", { name: "Playback" });
    expect(within(playback).getByRole("button", { name: "Play" })).toBeTruthy();
    expect(within(playback).getByRole("button", { name: "Auto-scroll on" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(playback).getByRole("button", { name: "Back 15 seconds" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to player" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text size" })).toBeTruthy();

    fireEvent.click(within(playback).getByRole("button", { name: "Auto-scroll on" }));
    expect(within(playback).getByRole("button", { name: "Auto-scroll off" }).getAttribute("aria-pressed")).toBe("false");

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
