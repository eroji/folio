import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerContextValue } from "./PlayerProvider";
import { TTS_LOOKAHEAD } from "./PlayerProvider";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, CH2, installPlayerFetch, makeSegments, renderPlayer, stubMedia } from "../test/player";
import type { AudioStatus } from "../api/audio";

let prepareCalls: { segment_id: string; count: number; voice?: string }[] = [];
let played: HTMLMediaElement[] = [];

beforeEach(() => {
  installMockEventSource();
  prepareCalls = installPlayerFetch().prepareCalls;
  played = stubMedia().played;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadAndPlay(getPlayer: () => PlayerContextValue) {
  await act(async () => {
    await getPlayer().load(BOOK_ID);
  });
  await act(async () => {
    getPlayer().toggle();
  });
  await waitFor(() => expect(getPlayer().playing).toBe(true));
}

describe("PlayerProvider", () => {
  it("prepares the current segment plus TTS_LOOKAHEAD and starts playback", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    expect(prepareCalls.some((call) => call.segment_id === `${CH1}-seg0` && call.count === TTS_LOOKAHEAD)).toBe(true);
    expect(getPlayer().elements[0].src).toContain(`${CH1}-seg0`);
    expect(played).toContain(getPlayer().elements[0]);
  });

  it("hands off to the second element on ended without reloading the source", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const [a, b] = getPlayer().elements;
    expect(b.src).toContain(`${CH1}-seg1`); // preloaded by lookahead
    const callsBefore = prepareCalls.length;
    act(() => {
      a.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    expect(played).toContain(b);
    expect(prepareCalls.length).toBe(callsBefore); // next segment was already known ready
  });

  it("auto-advances to the next chapter when the chapter ends", async () => {
    installPlayerFetch({ segmentsByChapter: { [CH1]: makeSegments(CH1, 1), [CH2]: makeSegments(CH2, 1) } });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().elements[0].dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    expect(getPlayer().index).toBe(0);
    expect(getPlayer().elements[1].src).toContain(`${CH2}-seg0`);
    expect(played).toContain(getPlayer().elements[1]);
  });

  it("applies playback speed to both elements and clamps to 0.75–2.5", () => {
    const getPlayer = renderPlayer();
    const [a, b] = getPlayer().elements;
    getPlayer().setRate(1.25);
    expect([a.playbackRate, b.playbackRate]).toEqual([1.25, 1.25]);
    getPlayer().setRate(10);
    expect(a.playbackRate).toBe(2.5);
    getPlayer().setRate(0.1);
    expect(a.playbackRate).toBe(0.75);
  });

  it("pauses when the minute-based sleep timer elapses", async () => {
    vi.useFakeTimers();
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
      getPlayer().toggle();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getPlayer().playing).toBe(true);
    act(() => {
      getPlayer().setSleep(15);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(getPlayer().playing).toBe(false);
  });

  it("stops at the chapter end with the end-of-chapter sleep timer", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().setSleep("chapter");
    });
    act(() => {
      getPlayer().elements[0].dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    act(() => {
      getPlayer().elements[1].dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().playing).toBe(false));
    expect(getPlayer().chapter?.id).toBe(CH1);
  });

  it("shows preparing, then plays once polling finds the segment ready", async () => {
    vi.useFakeTimers();
    const fixture: { statuses: Record<string, AudioStatus> } = { statuses: { [`${CH1}-seg0`]: "generating" } };
    installPlayerFetch(fixture);
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    await act(async () => {
      getPlayer().toggle();
    });
    expect(getPlayer().preparing).toBe(true);
    expect(getPlayer().playing).toBe(false);
    fixture.statuses![`${CH1}-seg0`] = "ready";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getPlayer().playing).toBe(true);
  });

  it("starts at the saved default speed", async () => {
    installPlayerFetch({ settings: { speed: 1.5 } });
    const getPlayer = renderPlayer();
    await waitFor(() => expect(getPlayer().rate).toBe(1.5));
    expect(getPlayer().elements[0].playbackRate).toBe(1.5);
  });

  it("skips by the configured back and forward intervals", async () => {
    installPlayerFetch({ settings: { skip_back: 2, skip_forward: 5 } });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    await waitFor(() => expect(getPlayer().settings.skip_forward).toBe(5));
    act(() => getPlayer().skipForward());
    expect(getPlayer().chapterElapsed).toBeCloseTo(5, 5);
    act(() => getPlayer().skipBack());
    expect(getPlayer().chapterElapsed).toBeCloseTo(3, 5);
  });

  it("stops at the chapter end when auto-play-next is off", async () => {
    installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 1), [CH2]: makeSegments(CH2, 1) },
      settings: { auto_next: false },
    });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    await waitFor(() => expect(getPlayer().settings.auto_next).toBe(false));
    act(() => {
      getPlayer().elements[0].dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().playing).toBe(false));
    expect(getPlayer().chapter?.id).toBe(CH1);
  });

  it("passes the saved language voice to prepare", async () => {
    const { prepareCalls: calls } = installPlayerFetch({ settings: { voices: { en: "danny-en" } } });
    const getPlayer = renderPlayer();
    await waitFor(() => expect(getPlayer().settings.voices.en).toBe("danny-en"));
    await loadAndPlay(getPlayer);
    expect(calls.some((call) => call.voice === "danny-en")).toBe(true);
  });
});
