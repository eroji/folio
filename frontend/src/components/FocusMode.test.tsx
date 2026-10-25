import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import {
  BOOK_ID,
  CH1,
  CH2,
  installPlayerFetch,
  makeProgress,
  renderPlayer,
  stubMedia,
  type PlayerFixture,
} from "../test/player";
import type { PlayerContextValue } from "../player/usePlayer";
import { FocusMode } from "./FocusMode";

/** Mount FocusMode over a loaded book (saved at chapter one, second segment). */
async function openFocus(
  fixture: PlayerFixture = { progress: makeProgress({}) },
): Promise<{ getPlayer: () => PlayerContextValue; onExit: ReturnType<typeof vi.fn> }> {
  installMockEventSource();
  installPlayerFetch(fixture);
  stubMedia();
  const onExit = vi.fn();
  const getPlayer = renderPlayer(<FocusMode onExit={onExit} />, ["/"]);
  await act(async () => {
    await getPlayer().load(BOOK_ID);
  });
  return { getPlayer, onExit };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FocusMode", () => {
  it("shows the book header with A−/A+, contents and exit controls", async () => {
    await openFocus();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("Frank Herbert")).toBeTruthy();
    const exit = screen.getByRole("button", { name: "Exit focus mode" });
    expect(exit.getAttribute("title")).toBe("Exit focus mode (Esc)");
    const contents = screen.getByRole("button", { name: "Show contents" });
    expect(contents.getAttribute("title")).toBe("Contents (C)");
    expect(contents.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Smaller text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Larger text" })).toBeTruthy();
  });

  it("toggles contents with C and exits on Escape", async () => {
    const { onExit } = await openFocus();
    expect(screen.getByRole("navigation", { name: "Contents" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "c" });
    expect(screen.queryByRole("navigation", { name: "Contents" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show contents" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "c" });
    expect(screen.getByRole("navigation", { name: "Contents" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("toggles playback with Space", async () => {
    const { getPlayer } = await openFocus();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(getPlayer().playing).toBe(false);
  });

  it("A+ / A− change the reading size and persist the step", async () => {
    await openFocus();
    const text = document.querySelector<HTMLElement>("[data-font-step]")!;
    expect(text.dataset.fontStep).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(text.dataset.fontStep).toBe("1");
    expect(localStorage.getItem("folio-readalong-font")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(text.dataset.fontStep).toBe("0");
    expect(localStorage.getItem("folio-readalong-font")).toBe("0");
  });

  it("marks the current chapter with its percent and opens a chapter on click", async () => {
    const { getPlayer } = await openFocus();
    const nav = screen.getByRole("navigation", { name: "Contents" });
    const rows = within(nav).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows[0]?.textContent).toContain("70%"); // 14 s of 20 s
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Chapter One");
    expect(screen.getByText("Chapter 1")).toBeTruthy();
    fireEvent.click(rows[1]!);
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    await waitFor(() =>
      expect(within(nav).getAllByRole("button")[0]?.textContent).toContain("Played"),
    );
  });

  it("drives the provider from the transport card", async () => {
    const { getPlayer } = await openFocus();
    const card = screen.getByRole("region", { name: "Now playing" });
    expect(within(card).getByRole("slider", { name: "Position in chapter" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Play" }));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    fireEvent.click(within(card).getByRole("button", { name: "Pause" }));
    expect(getPlayer().playing).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: "Playback speed, 1 times" }));
    expect(getPlayer().rate).toBe(1.25);
    fireEvent.click(within(card).getByRole("button", { name: "Next chapter" }));
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    fireEvent.click(within(card).getByRole("button", { name: "Previous chapter" }));
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH1));
    fireEvent.click(within(card).getByRole("button", { name: "Forward 30 seconds" }));
    await waitFor(() => expect(getPlayer().time).toBe(10));
    fireEvent.click(within(card).getByRole("button", { name: "Back 15 seconds" }));
    await waitFor(() => expect(getPlayer().index).toBe(0));
    expect(getPlayer().time).toBe(5);
    fireEvent.click(within(card).getByRole("button", { name: "Sleep timer, off" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "15 minutes" }));
    expect(getPlayer().sleep).toBe(15);
    expect(within(card).getByRole("button", { name: "Sleep timer, 15 minutes" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Narrator voice, default" })).toBeTruthy();
  });

  it("sets the reading page lang from the book", async () => {
    await openFocus();
    expect(document.querySelector(".reader-scroll")?.getAttribute("lang")).toBe("en");
  });

  it("shows every chapter as played when the book is finished", async () => {
    await openFocus({ progress: makeProgress({ finished_at: "2026-01-03T00:00:00Z" }) });
    const rows = within(screen.getByRole("navigation", { name: "Contents" })).getAllByRole("button");
    for (const row of rows) expect(row.textContent).toContain("Played");
  });
});
