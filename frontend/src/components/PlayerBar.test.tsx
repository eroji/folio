import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, CH2, installPlayerFetch, makeProgress, renderPlayer, stubMedia } from "../test/player";
import { deviceLabel } from "../api/progress";
import { PlayerBar } from "./PlayerBar";
import type { PlayerContextValue } from "../player/usePlayer";

function Where() {
  const location = useLocation();
  return <p>{`${location.pathname}${location.search}`}</p>;
}

async function loadBar(entries: string[] = ["/"]): Promise<() => PlayerContextValue> {
  const getPlayer = renderPlayer(
    <>
      <PlayerBar />
      <Where />
    </>,
    entries,
  );
  await act(async () => {
    await getPlayer().load(BOOK_ID);
  });
  return getPlayer;
}

beforeEach(() => {
  localStorage.clear();
  installMockEventSource();
  installPlayerFetch();
  stubMedia();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlayerBar", () => {
  it("shows the bar only while a book is loaded, and Stop hides it", async () => {
    const getPlayer = renderPlayer(<PlayerBar />);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(await screen.findByRole("region", { name: "Now playing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop and close player" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull());
    expect(getPlayer().book).toBeNull();
  });

  it("the 32 px cover stays clean: no percent badge in the player bar", async () => {
    await loadBar();
    const bar = await screen.findByRole("region", { name: "Now playing" });
    expect(within(bar).queryByText(/^\d+%$/)).toBeNull();
  });

  it("play/pause, skips and chapter steps drive the provider", async () => {
    const getPlayer = await loadBar();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Pause" })));
    expect(getPlayer().playing).toBe(false);

    // Seek to 15 s into the chapter; back 15 lands at 0.
    act(() => {
      getPlayer().seekChapter(15);
    });
    expect(getPlayer().chapterElapsed).toBeCloseTo(15, 0);
    fireEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
    await waitFor(() => expect(getPlayer().chapterElapsed).toBe(0));

    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    fireEvent.click(screen.getByRole("button", { name: "Previous chapter" }));
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH1));
  });

  it("speed button opens the speed card with a vertical slider", async () => {
    await loadBar();
    const speed = screen.getByRole("button", { name: "Playback speed, 1.0 times" });
    expect(speed.textContent).toBe("1.0×");
    expect(speed.getAttribute("aria-haspopup")).toBe("dialog");
    expect(speed.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(speed);
    const dialog = await screen.findByRole("dialog", { name: "Playback speed" });
    expect(speed.getAttribute("aria-expanded")).toBe("true");
    expect(speed.className).toContain("bg-raised"); // raised fill while open
    expect(dialog.className).toContain("w-[84px]"); // 84 px card, 20 px radius
    expect(dialog.className).toContain("rounded-2xl");
    expect(dialog.className).toContain("-translate-x-1/2"); // centered above the button
    expect(within(dialog).getByText("1.0×")).toBeTruthy(); // the value: the only number shown
    expect(within(dialog).getByText("Speed")).toBeTruthy(); // eyebrow

    const slider = within(dialog).getByRole("slider", { name: "Playback speed" });
    expect(slider.getAttribute("aria-orientation")).toBe("vertical");
    expect(slider.getAttribute("aria-valuemin")).toBe("0.9");
    expect(slider.getAttribute("aria-valuemax")).toBe("1.15");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("1.0 times");
    expect(slider.className).toContain("h-[210px]"); // 210 px track
    expect(dialog.querySelectorAll("[data-speed-step]")).toHaveLength(6); // dot per position
    expect(dialog.querySelector("[data-speed-thumb]")).toBeTruthy();
    expect(document.activeElement).toBe(slider); // focused when opened

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull());

    fireEvent.click(speed); // toggles open again
    await screen.findByRole("dialog", { name: "Playback speed" });
    fireEvent.click(document.body); // outside click closes
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull());
  });

  it("the speed card moves one step with arrows, two with page keys, Home/End to the ends", async () => {
    const getPlayer = await loadBar();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.0 times" }));
    const slider = await screen.findByRole("slider", { name: "Playback speed" });
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(getPlayer().rate).toBe(1.05);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(getPlayer().rate).toBe(1.1);
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(getPlayer().rate).toBe(1.05);
    fireEvent.keyDown(slider, { key: "PageDown" });
    expect(getPlayer().rate).toBe(0.95);
    fireEvent.keyDown(slider, { key: "End" });
    expect(getPlayer().rate).toBe(1.15);
    fireEvent.keyDown(slider, { key: "PageUp" }); // clamps at the top
    expect(getPlayer().rate).toBe(1.15);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(getPlayer().rate).toBe(0.9);
    expect(screen.getByRole("button", { name: "Playback speed, 0.9 times" }).textContent).toBe("0.9×");
  });

  it("clicking the track jumps to the nearest step", async () => {
    const getPlayer = await loadBar();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.0 times" }));
    const slider = await screen.findByRole("slider", { name: "Playback speed" });
    slider.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 28,
        bottom: 210,
        width: 28,
        height: 210,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.pointerDown(slider, { clientY: 35 }); // 5/6 up → 1.108 → snaps to 1.1
    expect(getPlayer().rate).toBe(1.1);
    fireEvent.pointerDown(slider, { clientY: 210 }); // bottom of the track = min
    expect(getPlayer().rate).toBe(0.9);
  });

  it("the speed card closes 3 s after the last change", async () => {
    vi.useFakeTimers();
    const getPlayer = renderPlayer(<PlayerBar />);
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.0 times" }));
    const slider = screen.getByRole("slider", { name: "Playback speed" });
    fireEvent.keyDown(slider, { key: "ArrowUp" }); // 1.05, restarts the timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.keyDown(slider, { key: "ArrowUp" }); // 1.1, restarts it again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2900);
    });
    expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByRole("dialog", { name: "Playback speed" })).toBeNull();
    expect(getPlayer().rate).toBe(1.1);
  });

  it("the speed card positions come from the config grid", async () => {
    installPlayerFetch({ speedOptions: { min: 0.9, max: 1.2, step: 0.1 } });
    const getPlayer = await loadBar();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.0 times" }));
    const dialog = await screen.findByRole("dialog", { name: "Playback speed" });
    const slider = within(dialog).getByRole("slider", { name: "Playback speed" });
    expect(slider.getAttribute("aria-valuemax")).toBe("1.2");
    expect(dialog.querySelectorAll("[data-speed-step]")).toHaveLength(4);
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() => expect(getPlayer().rate).toBe(1.2));
  });

  it("the sleep menu sets the timer", async () => {
    const getPlayer = await loadBar();
    fireEvent.click(screen.getByRole("button", { name: "Sleep timer" }));
    const menu = await screen.findByRole("menu", { name: "Sleep timer" });
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "30 minutes" }));
    await waitFor(() => expect(getPlayer().sleep).toBe(30));
    expect(screen.getByRole("button", { name: "Sleep timer, 30 minutes" })).toBeTruthy();
  });

  it("opens the expanded player from the middle block and the chevron", async () => {
    await loadBar();
    expect(screen.getByRole("link", { name: "Open player" }).getAttribute("href")).toBe("/player");
    expect(screen.getByRole("link", { name: /Chapter One/ }).getAttribute("href")).toBe("/player");
    fireEvent.click(screen.getByRole("link", { name: "Open player" }));
    await screen.findByRole("button", { name: "Close player" });
    expect(screen.queryByRole("link", { name: "Open player" })).toBeNull();
  });

  it("on /player the chevron becomes Close player and returns to the book", async () => {
    await loadBar([`/player?book=${BOOK_ID}&chapter=${CH1}`]);
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    await screen.findByText(`/books/${BOOK_ID}`);
  });

  it("replaces the subtitle with the other-device line when another device held the book", async () => {
    installPlayerFetch({ progress: makeProgress({ device_label: "Kitchen speaker" }) });
    const getPlayer = renderPlayer(
      <>
        <PlayerBar />
        <Where />
      </>,
      ["/"],
    );
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().lastDevice?.label).toBe("Kitchen speaker");
    expect(getPlayer().lastDevice?.label).not.toBe(deviceLabel());
    await screen.findByText(/Paused · last played on Kitchen speaker/);
  });

  it("has no narrator voice button", async () => {
    await loadBar();
    expect(screen.queryByRole("button", { name: /voice|narrator/i })).toBeNull();
  });
});
