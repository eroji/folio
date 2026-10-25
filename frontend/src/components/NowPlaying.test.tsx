import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH2, installPlayerFetch, makeProgress, stubMedia } from "../test/player";
import { deviceLabel } from "../api/progress";
import { PlayerProvider } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { COLLAPSE_KEY, PlayerSurfaces, usePlayerCollapsed } from "./NowPlaying";
import type { PlayerContextValue } from "../player/usePlayer";

let current: PlayerContextValue | undefined;
function Probe() {
  current = usePlayer();
  return null;
}

function Surfaces() {
  const [collapsed, toggleCollapse] = usePlayerCollapsed();
  return <PlayerSurfaces collapsed={collapsed} onToggleCollapse={toggleCollapse} onFocus={() => undefined} />;
}

function renderSurfaces(): () => PlayerContextValue {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current = undefined;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <PlayerProvider>
          <Probe />
          <Routes>
            <Route path="/" element={<Surfaces />} />
            <Route path="/player" element={<p>Full player screen</p>} />
          </Routes>
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => current!;
}

async function loadBook(): Promise<void> {
  await act(async () => {
    await current!.load(BOOK_ID);
  });
}

function panel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Now playing" });
}
function bar(): HTMLElement {
  return screen.getAllByRole("region", { name: "Now playing" })[0]!;
}
function sheet(): HTMLElement {
  return screen.getAllByRole("region", { name: "Now playing" })[1]!;
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

describe("PlayerSurfaces", () => {
  it("shows panel, bar and sheet whenever a book is loaded — playing or paused", async () => {
    const getPlayer = renderSurfaces();
    expect(screen.queryByRole("complementary", { name: "Now playing" })).toBeNull();
    await loadBook();
    expect(screen.getByRole("complementary", { name: "Now playing" })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "Now playing" })).toHaveLength(2);
    await act(async () => {
      await getPlayer().play();
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(screen.getByRole("complementary", { name: "Now playing" })).toBeTruthy();
    await act(async () => {
      getPlayer().pause();
    });
    expect(screen.getByRole("complementary", { name: "Now playing" })).toBeTruthy();
  });

  it("close stops the player and unmounts every surface", async () => {
    const getPlayer = renderSurfaces();
    await loadBook();
    fireEvent.click(within(panel()).getByRole("button", { name: "Stop and close player" }));
    await waitFor(() => expect(getPlayer().book).toBeNull());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryAllByRole("region", { name: "Now playing" })).toHaveLength(0);
  });

  it("collapse persists the preference, and expand reverses it", async () => {
    renderSurfaces();
    await loadBook();
    fireEvent.click(within(panel()).getByRole("button", { name: "Collapse player to a bar" }));
    await waitFor(() => expect(localStorage.getItem(COLLAPSE_KEY)).toBe("true"));
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(bar().hasAttribute("inert")).toBe(false);
    fireEvent.click(within(bar()).getByRole("button", { name: "Expand player" }));
    await waitFor(() => expect(localStorage.getItem(COLLAPSE_KEY)).toBe("false"));
    expect(panel().hasAttribute("inert")).toBe(false);
  });

  it("names the header buttons with their shortcuts as tooltips", async () => {
    renderSurfaces();
    await loadBook();
    const buttons: [string, string][] = [
      ["Collapse player to a bar", "Collapse player (P)"],
      ["Open focus reading mode", "Focus mode (F)"],
      ["Stop and close player", "Stop and close player"],
    ];
    for (const [label, title] of buttons) {
      expect(within(panel()).getByRole("button", { name: label }).getAttribute("title")).toBe(title);
    }
  });

  it("shows the other-device line when the saved position came from another device", async () => {
    installPlayerFetch({
      progress: makeProgress({
        device_label: "Pixel 9 ab12",
        updated_at: new Date(Date.now() - 120_000).toISOString(),
      }),
    });
    renderSurfaces();
    await loadBook();
    const status = await within(panel()).findByRole("status");
    expect(status.textContent).toContain("Paused · last played on Pixel 9 ab12");
    expect(status.textContent).toMatch(/min\.? ago/);
  });

  it("shows no other-device line when the position is this device's", async () => {
    installPlayerFetch({ progress: makeProgress({ device_label: deviceLabel() }) });
    renderSurfaces();
    await loadBook();
    expect(within(panel()).queryByRole("status")).toBeNull();
  });

  it("tapping the sheet opens the full-screen phone player", async () => {
    renderSurfaces();
    await loadBook();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Expand player" }));
    expect(await screen.findByText("Full player screen")).toBeTruthy();
  });

  it("transport buttons drive the provider", async () => {
    const getPlayer = renderSurfaces();
    await loadBook();
    const p = panel();
    fireEvent.click(within(p).getByRole("button", { name: "Play" }));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    fireEvent.click(within(p).getByRole("button", { name: "Pause" }));
    expect(getPlayer().playing).toBe(false);
    fireEvent.click(within(p).getByRole("button", { name: "Next chapter" }));
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    fireEvent.click(within(p).getByRole("button", { name: "Forward 30 seconds" }));
    await waitFor(() => expect(getPlayer().chapterElapsed).toBeGreaterThan(0));
    fireEvent.click(within(p).getByRole("button", { name: "Playback speed, 1 times" }));
    await waitFor(() => expect(getPlayer().rate).toBe(1.25));
  });

  it("sleep timer shows a countdown badge while a timer runs", async () => {
    const getPlayer = renderSurfaces();
    await loadBook();
    fireEvent.click(within(panel()).getByRole("button", { name: "Sleep timer, off" }));
    const menu = await screen.findByRole("menu", { name: "Sleep timer" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "15 minutes" }));
    await waitFor(() => expect(getPlayer().sleep).toBe(15));
    const button = await waitFor(() =>
      within(panel()).getByRole("button", { name: "Sleep timer, 15 minutes" }),
    );
    expect(button.textContent).toContain("15:00");
  });

  it("keeps the read-along scrolling inside the panel and tagged with the book language", async () => {
    renderSurfaces();
    await loadBook();
    const reader = panel().querySelector<HTMLElement>(".reader-scroll")!;
    expect(reader.className).toContain("overflow-y-auto");
    expect(reader.getAttribute("lang")).toBe("en");
    expect(within(panel()).getByText("Chapter 1 · Dune")).toBeTruthy();
  });
});
