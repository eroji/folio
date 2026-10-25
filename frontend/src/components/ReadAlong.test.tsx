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
    delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
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

  it("auto-scrolls the panel, never the window", async () => {
    vi.useFakeTimers();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const panel = document.querySelector<HTMLElement>(".reader-scroll")!;
    let scrollTop = 0;
    Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
    Object.defineProperty(panel, "clientHeight", { configurable: true, get: () => 400 });
    for (const span of panel.querySelectorAll("span")) {
      Object.defineProperty(span, "offsetTop", { configurable: true, get: () => 900 });
    }
    panel.scrollTo = vi.fn((options?: ScrollToOptions) => {
      scrollTop = options?.top ?? 0;
    }) as unknown as typeof panel.scrollTo;
    const windowScroll = vi.spyOn(window, "scrollTo");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // past the throttle
    });
    const el = getPlayer().elements[0];
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(panel.scrollTop).toBe(700); // active sentence centered in the panel
    expect(window.scrollY).toBe(0);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it("auto-scrolls at most every 250 ms while time advances", async () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    Element.prototype.scrollTo = scroll;
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const el = getPlayer().elements[0];
    for (let i = 1; i <= 5; i += 1) {
      act(() => {
        el.currentTime = i;
        el.dispatchEvent(new Event("timeupdate"));
      });
    }
    expect(scroll).toHaveBeenCalledTimes(1); // the play render's scroll; the loop is throttled out
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("pauses auto-scroll for ~5 s after a manual scroll", async () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    Element.prototype.scrollTo = scroll;
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    const el = getPlayer().elements[0];
    const box = document.querySelector('[aria-live="off"]')!;
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.wheel(box);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      el.currentTime = 2;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(scroll).toHaveBeenCalledTimes(1); // suppressed while the user looks around
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() => {
      el.currentTime = 3;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(scroll).toHaveBeenCalledTimes(2); // resumed
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
