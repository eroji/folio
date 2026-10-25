import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, installPlayerFetch, makeSegments, renderPlayer, stubMedia } from "../test/player";
import type { PlayerContextValue } from "../player/usePlayer";
import { ReadAlong, splitSentences } from "./ReadAlong";

describe("splitSentences", () => {
  it("splits on Latin and CJK sentence punctuation", () => {
    expect(splitSentences("One two. Three four! Five。Six")).toEqual(["One two.", "Three four!", "Five。", "Six"]);
  });
});

describe("ReadAlong", () => {
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

  async function play(getPlayer: () => PlayerContextValue, fakeTimers = false) {
    await act(async () => {
      await getPlayer().load(BOOK_ID);
      getPlayer().toggle();
      if (fakeTimers) await vi.advanceTimersByTimeAsync(0); // waitFor cannot poll under fake timers
    });
    if (!fakeTimers) await waitFor(() => expect(getPlayer().playing).toBe(true));
  }

  function panel(): HTMLElement {
    return document.querySelector<HTMLElement>('article[aria-label="Read along"]')!;
  }

  it("marks the current sentence larger and bright, past dimmer, upcoming mid", async () => {
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    act(() => {
      getPlayer().seekChapter(15); // segment 1, 50 % → middle sentence
    });
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain(`Two ${CH1}-seg1 here`);
    expect(current?.className).toContain("ra-current");
    expect(current?.getAttribute("style")).toContain("font-size: 26px");
    expect(document.querySelector(".ra-past")).toBeTruthy();
    expect(document.querySelector(".ra-next")).toBeTruthy();
    expect(document.querySelector(".sr-only")?.textContent).toContain(`Two ${CH1}-seg1 here`);
  });

  /** Stub rAF/cAF so the test drives animation frames with explicit
   * timestamps. `starts` counts animations begun by the component. */
  function stubFrames() {
    let nextId = 1;
    let depth = 0;
    const starts: number[] = [];
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((cb: FrameRequestCallback) => {
      const id = nextId++;
      if (depth === 0) starts.push(id);
      frames.set(id, cb);
      return id;
    });
    const caf = vi.fn((id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    return {
      starts,
      caf,
      run: (time: number) => {
        const pending = [...frames.values()];
        frames.clear();
        depth += 1;
        act(() => {
          for (const cb of pending) cb(time);
        });
        depth -= 1;
      },
    };
  }

  /** Panel 400 px tall, the current sentence 900 px down → the follow target
   * is 900 − 400/3 ≈ 766.67 (a third from the top). */
  function stubPanelGeometry(box: HTMLElement, offsetTop = 900) {
    let scrollTop = 0;
    Object.defineProperty(box, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 400 });
    for (const node of box.querySelectorAll("p")) {
      Object.defineProperty(node, "offsetTop", { configurable: true, get: () => offsetTop });
    }
    return () => box.scrollTop;
  }

  it("auto-scrolls the current sentence to a third from the top, never the window", async () => {
    vi.useFakeTimers();
    const { starts, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const box = panel();
    const scrollTop = stubPanelGeometry(box);
    const windowScroll = vi.spyOn(window, "scrollTo");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // past the throttle
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts.length).toBeGreaterThan(0);
    run(1000);
    run(1300); // animation finished
    expect(scrollTop()).toBeCloseTo(900 - 400 / 3, 0);
    expect(window.scrollY).toBe(0);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("a manual scroll pauses the follow and shows Back to current", async () => {
    vi.useFakeTimers();
    const { starts, caf, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const box = panel();
    stubPanelGeometry(box);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    const before = starts.length;
    run(2000); // animation in flight
    fireEvent.wheel(box);
    expect(caf).toHaveBeenCalled(); // the follow animation stopped
    const pill = screen.getByRole("button", { name: "Back to current" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      el.currentTime = 8;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts.length).toBe(before); // suppressed while the reader looks around
    fireEvent.click(pill);
    expect(screen.queryByRole("button", { name: "Back to current" })).toBeNull();
    expect(starts.length).toBeGreaterThan(before); // and the follow resumed
  });

  it("the auto-scroll pill turns the follow off and on", async () => {
    vi.useFakeTimers();
    const { starts } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    stubPanelGeometry(panel());
    const pill = screen.getByRole("button", { name: "Auto-scroll on" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);
    expect(screen.getByRole("button", { name: "Auto-scroll off" }).getAttribute("aria-pressed")).toBe("false");
    const before = starts.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts.length).toBe(before); // no follow while off
    fireEvent.click(screen.getByRole("button", { name: "Auto-scroll off" }));
    expect(screen.getByRole("button", { name: "Auto-scroll on" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the text-size button cycles the reading size and persists it", () => {
    renderPlayer(<ReadAlong />);
    const box = panel();
    const size = screen.getByRole("button", { name: "Text size" });
    expect(box.dataset.fontStep).toBe("0");
    fireEvent.click(size);
    expect(box.dataset.fontStep).toBe("1");
    expect(localStorage.getItem("folio-readalong-font")).toBe("1");
    fireEvent.click(size);
    fireEvent.click(size); // wraps back to the default
    expect(box.dataset.fontStep).toBe("0");
  });

  it("restores the persisted text size on mount", () => {
    localStorage.setItem("folio-readalong-font", "2");
    renderPlayer(<ReadAlong />);
    expect(panel().dataset.fontStep).toBe("2");
  });

  it("tapping a sentence seeks there and prepares that segment", async () => {
    const { prepareCalls } = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 10) },
    });
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    fireEvent.click(screen.getByText(new RegExp(`Two ${CH1}-seg8 here`)));
    await waitFor(() => expect(getPlayer().index).toBe(8));
    expect(prepareCalls.at(-1)).toEqual({ segment_id: `${CH1}-seg8`, count: 6 });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
  });
});
