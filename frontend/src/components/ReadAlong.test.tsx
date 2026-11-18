import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, installPlayerFetch, makeSegments, renderPlayer, stubMedia } from "../test/player";
import type { PlayerContextValue } from "../player/usePlayer";
import { ReadAlong, SIZE_NAMES, TEXT_SIZES, splitSentences } from "./ReadAlong";

describe("splitSentences", () => {
  it("splits on Latin and CJK sentence punctuation", () => {
    expect(splitSentences("One two. Three four! Five。Six")).toEqual(["One two.", "Three four!", "Five。", "Six"]);
  });

  it("keeps closing quotes and brackets with the sentence they end", () => {
    expect(splitSentences("He said \u2018gone.\u2019 Then left. \u201CAway!\u201D Done.")).toEqual([
      "He said \u2018gone.\u2019",
      "Then left.",
      "\u201CAway!\u201D",
      "Done.",
    ]);
    expect(splitSentences("It ended.\u2019 Next day.")).toEqual(["It ended.\u2019", "Next day."]);
    expect(splitSentences("She left (at noon). Then came back.")).toEqual(["She left (at noon).", "Then came back."]);
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

  it("follows the clip's sentence marks instead of an even spread", async () => {
    const [seg0, seg1] = makeSegments(CH1, 2);
    const text = seg1!.text;
    const at = (s: string) => text.indexOf(s) / text.length;
    // Sentence two of segment 1 only starts 8 s into its 10 s clip.
    installPlayerFetch({
      marks: { [seg1!.id]: [[0, 0], [at("Two"), 8], [at("Three"), 9]] },
      segmentsByChapter: { [CH1]: [seg0!, seg1!] },
    });
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    await waitFor(() => expect(getPlayer().status[seg1!.id]?.marks).toBeTruthy());
    act(() => {
      getPlayer().seekChapter(15); // 5 s into segment 1: an even spread says sentence two
    });
    await waitFor(() =>
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(`One ${CH1}-seg1 here`),
    );
    act(() => {
      getPlayer().seekChapter(18.5); // 8.5 s: after the mark
    });
    await waitFor(() =>
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(`Two ${CH1}-seg1 here`),
    );
  });

  it("marks the current sentence bright and 4px larger, past dimmer, upcoming mid", async () => {
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer);
    act(() => {
      getPlayer().seekChapter(15); // segment 1, 50 % → middle sentence
    });
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain(`Two ${CH1}-seg1 here`);
    expect(current?.className).toContain("ra-current");
    expect(current?.getAttribute("style")).toContain("font-size: 26px"); // 22px body + 4
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
    const el = getPlayer().element;
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

  it("follows the audio clock at rAF cadence: no animation within a sentence, highlight moves within one frame", async () => {
    vi.useFakeTimers();
    const { starts, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    stubPanelGeometry(panel());
    const el = getPlayer().element;
    // Still inside the first sentence: the loop runs, but no scroll
    // animation starts and no re-render moves the highlight.
    const before = starts.length;
    act(() => {
      el.currentTime = 1;
    });
    run(1000);
    expect(starts.length).toBe(before);
    // Past the boundary: one frame later the highlight has followed, without
    // a single timeupdate event — the position comes from the element clock.
    act(() => {
      el.currentTime = 6;
    });
    run(1033);
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(`Two ${CH1}-seg0 here`);
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
    const el = getPlayer().element;
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

  it("the round auto-scroll toggle turns the follow off and on", async () => {
    vi.useFakeTimers();
    const { starts } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await play(getPlayer, true);
    stubPanelGeometry(panel());
    const toggle = screen.getByRole("button", { name: "Auto-scroll" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Auto-scroll: on");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("title")).toBe("Auto-scroll: off");
    const before = starts.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const el = getPlayer().element;
    act(() => {
      el.currentTime = 6;
      el.dispatchEvent(new Event("timeupdate"));
    });
    expect(starts.length).toBe(before); // no follow while off
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("follows the current sentence on segment change without toggling auto-scroll", async () => {
    vi.useFakeTimers();
    const { starts, run } = stubFrames();
    const getPlayer = renderPlayer(<ReadAlong />);
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    const box = panel();
    const scrollTop = stubPanelGeometry(box);
    const before = starts.length;
    act(() => {
      getPlayer().seekSegment(1, 0); // current segment changes while paused
    });
    expect(starts.length).toBeGreaterThan(before); // the follow ran without any toggle
    run(1000); // the layout effect's frame calls scrollToCurrent
    run(1300);
    run(1600); // animation finished
    expect(scrollTop()).toBeCloseTo(900 - 400 / 3, 0);
  });

  it("reads at the default Large size in a 620px column that scrolls internally", () => {
    renderPlayer(<ReadAlong />);
    const box = panel();
    const column = box.parentElement!;
    expect(column.className).toContain("max-w-[620px]");
    expect(column.className).toContain("min-h-0");
    expect(box.className).toContain("min-h-0");
    expect(box.className).toContain("flex-1");
    expect(box.className).toContain("overflow-y-auto");
    expect(box.className).toContain("scroll-thin"); // desktop shows the styled scrollbar
    expect(box.className).not.toContain("no-scrollbar");
    expect(box.dataset.sizeStep).toBe("2");
    const text = box.firstElementChild as HTMLElement;
    expect(text.getAttribute("style")).toContain("font-size: 22px");
    expect(text.getAttribute("style")).toContain("line-height: 1.55");
  });

  it("hides the scrollbar in the phone sheet and uses the same five steps", () => {
    renderPlayer(<ReadAlong phone />);
    const box = panel();
    expect(box.className).toContain("no-scrollbar");
    expect(box.className).not.toContain("scroll-thin");
    expect((box.firstElementChild as HTMLElement).getAttribute("style")).toContain("font-size: 22px");
    fireEvent.click(screen.getByRole("button", { name: "Text size" }));
    fireEvent.click(screen.getByRole("radio", { name: "Small" }));
    expect((box.firstElementChild as HTMLElement).getAttribute("style")).toContain("font-size: 17px");
  });

  it("the header has the Aa pill and the round toggle, no A−/A+", () => {
    renderPlayer(<ReadAlong />);
    expect(screen.getByRole("button", { name: "Text size" }).textContent).toBe("Aa");
    expect(screen.getByRole("button", { name: "Auto-scroll" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Increase font size/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Decrease font size/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Auto-scroll (on|off)$/ })).toBeNull();
  });

  it("the text size popover opens below Aa and closes on toggle, outside click or Escape", async () => {
    renderPlayer(<ReadAlong />);
    const trigger = screen.getByRole("button", { name: "Text size" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Text size" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Text size" })).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Text size" });
    fireEvent.click(document.body); // outside click
    expect(screen.queryByRole("dialog", { name: "Text size" })).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Text size" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Text size" })).toBeNull();
  });

  it("the popover lists five named steps with the current one selected", () => {
    renderPlayer(<ReadAlong />);
    fireEvent.click(screen.getByRole("button", { name: "Text size" }));
    const dialog = screen.getByRole("dialog", { name: "Text size" });
    expect(dialog.className).toContain("w-[300px]");
    expect(dialog.className).toContain("rounded-2xl");
    expect(dialog.className).toContain("bg-raised");
    expect(screen.getByText("Text size", { selector: "[role='dialog'] span" })).toBeTruthy();
    expect(screen.getByText("Used for read along in every book.")).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(SIZE_NAMES);
    expect(radios.map((r) => (r as HTMLElement).style.fontSize)).toEqual(["13px", "16px", "19px", "22px", "26px"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false"]);
    expect(dialog.textContent).toContain("Large"); // current name on the right
  });

  it("choosing a step resizes the body, marks the radio, and persists", () => {
    renderPlayer(<ReadAlong />);
    const box = panel();
    for (const [i, name] of SIZE_NAMES.entries()) {
      fireEvent.click(screen.getByRole("button", { name: "Text size" })); // the pick closes the popover
      fireEvent.click(screen.getByRole("radio", { name }));
      expect((box.firstElementChild as HTMLElement).getAttribute("style")).toContain(`font-size: ${TEXT_SIZES[i]}px`);
      expect(box.dataset.sizeStep).toBe(String(i));
      expect(localStorage.getItem("folio-readalong-size")).toBe(String(i));
    }
    fireEvent.click(screen.getByRole("button", { name: "Text size" }));
    expect(screen.getByRole("radio", { name: "Huge" }).getAttribute("aria-checked")).toBe("true");
  });

  it("restores the persisted text size on mount", () => {
    localStorage.setItem("folio-readalong-size", "4");
    renderPlayer(<ReadAlong />);
    expect(panel().dataset.sizeStep).toBe("4");
    expect((panel().firstElementChild as HTMLElement).getAttribute("style")).toContain("font-size: 28px");
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
