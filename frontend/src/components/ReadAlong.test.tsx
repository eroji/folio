import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, CH2, installPlayerFetch, makeSegments, renderPlayer, stubMedia } from "../test/player";
import type { PlayerContextValue } from "../player/PlayerProvider";
import { ReadAlong, splitSentences } from "./ReadAlong";

describe("splitSentences", () => {
  it("splits on Latin and CJK sentence punctuation", () => {
    expect(splitSentences("One two. Three four! Five。Six")).toEqual(["One two.", "Three four!", "Five。", "Six"]);
  });
});

describe("ReadAlong", () => {
  beforeEach(() => {
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

  it("marks the sentence at the spoken character offset active and mirrors it to the live region", async () => {
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    act(() => {
      getPlayer().seekChapter(15); // segment 1, half its duration → middle sentence
    });
    const active = document.querySelector('[aria-current="true"]');
    expect(active?.textContent).toContain(`Two ${CH1}-seg1 here`);
    expect(document.querySelector(".sr-only")?.textContent).toContain(`Two ${CH1}-seg1 here`);
  });

  /** Stub rAF/cAF so the test drives animation frames with explicit
   * timestamps. `starts` counts animations begun by the component (rAF calls
   * made outside a frame callback), so chained continuations do not skew it. */
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

  function stubPanelGeometry(panel: HTMLElement, offsetTop = 900) {
    let scrollTop = 0;
    Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
    Object.defineProperty(panel, "clientHeight", { configurable: true, get: () => 400 });
    for (const span of panel.querySelectorAll("span")) {
      Object.defineProperty(span, "offsetTop", { configurable: true, get: () => offsetTop });
    }
    return () => panel.scrollTop;
  }

  it("auto-scrolls the panel in animation steps, never the window, replacing the previous animation", async () => {
    vi.useFakeTimers();
    const { starts, caf, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const panel = document.querySelector<HTMLElement>(".reader-scroll")!;
    const scrollTop = stubPanelGeometry(panel);
    const windowScroll = vi.spyOn(window, "scrollTo");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // past the throttle
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(1); // one animation toward the new target
    run(1000); // t=0
    run(1150); // t≈0.5 of the 300 ms animation → eased to 75 % of 700
    expect(scrollTop()).toBeCloseTo(525, 0);
    expect(scrollTop()).toBeLessThan(700); // still in flight, not a jump
    act(() => {
      el.currentTime = 7;
      el.dispatchEvent(new Event("timeupdate"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // past the throttle → target moves
    });
    act(() => {
      el.currentTime = 8;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(caf).toHaveBeenCalledTimes(1); // the in-flight animation was cancelled
    expect(starts).toHaveLength(2); // …and replaced by a new one
    run(2000);
    run(2300); // animation finished
    expect(scrollTop()).toBe(700); // active sentence centered in the panel
    expect(window.scrollY).toBe(0);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("refreshes the scroll target at most every 250 ms while time advances", async () => {
    vi.useFakeTimers();
    const { starts, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const panel = document.querySelector<HTMLElement>(".reader-scroll")!;
    stubPanelGeometry(panel);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // past the initial throttle
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 1;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(1); // target moved off 0 → one animation started
    run(1000);
    for (let i = 2; i <= 5; i += 1) {
      act(() => {
        el.currentTime = i;
        el.dispatchEvent(new Event("timeupdate"));
      });
    }
    expect(starts).toHaveLength(1); // the loop is throttled out
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(2);
  });

  it("stops the animation and pauses auto-scroll for ~5 s after a manual scroll", async () => {
    vi.useFakeTimers();
    const { starts, caf, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const panel = document.querySelector<HTMLElement>(".reader-scroll")!;
    stubPanelGeometry(panel);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 1;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(1);
    run(1000); // animation in flight
    fireEvent.wheel(panel);
    expect(caf).toHaveBeenCalledTimes(1); // stopped immediately
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      el.currentTime = 2;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(1); // suppressed while the user looks around
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() => {
      el.currentTime = 3;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts).toHaveLength(2); // resumed
  });

  it("tapping a sentence seeks there and prepares that segment", async () => {
    const { prepareCalls } = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 10), [CH2]: makeSegments(CH2, 1) },
    });
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    fireEvent.click(screen.getByText(new RegExp(`Two ${CH1}-seg8 here`)));
    await waitFor(() => expect(getPlayer().index).toBe(8));
    expect(prepareCalls.at(-1)).toEqual({ segment_id: `${CH1}-seg8`, count: 6 });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
  });

  it("A+ enlarges one step, clamps at the top, and persists the choice", () => {
    localStorage.clear();
    renderPlayer(<ReadAlong />);
    const box = document.querySelector('[aria-live="off"]') as HTMLElement;
    const up = screen.getByRole("button", { name: /Increase font size/ });
    const down = screen.getByRole("button", { name: /Decrease font size/ });
    expect(box.dataset.fontStep).toBe("0");
    expect((down as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up);
    expect(box.dataset.fontStep).toBe("1");
    expect(localStorage.getItem("folio-readalong-font")).toBe("1");
    fireEvent.click(up);
    fireEvent.click(up); // clamps at the largest step
    expect(box.dataset.fontStep).toBe("2");
    expect((up as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(down);
    expect(box.dataset.fontStep).toBe("1");
    expect(localStorage.getItem("folio-readalong-font")).toBe("1");
  });

  it("restores the persisted font step on mount", () => {
    localStorage.setItem("folio-readalong-font", "2");
    renderPlayer(<ReadAlong />);
    expect((document.querySelector('[aria-live="off"]') as HTMLElement).dataset.fontStep).toBe("2");
  });
});
