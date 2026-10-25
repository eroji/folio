import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerProvider, TTS_LOOKAHEAD, type PlayerContextValue } from "./PlayerProvider";
import { usePlayer } from "./usePlayer";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, CH2, installPlayerFetch, makeSegments, stubMedia } from "../test/player";
import type { AudioStatus } from "../api/audio";

let current: PlayerContextValue | undefined;
function Probe() {
  current = usePlayer();
  return null;
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/player"]}>
        <PlayerProvider>
          <Probe />
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => current!;
}

let prepareCalls: { segment_id: string; count: number }[] = [];
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
    const getPlayer = setup();
    await loadAndPlay(getPlayer);
    expect(prepareCalls.some((call) => call.segment_id === `${CH1}-seg0` && call.count === TTS_LOOKAHEAD)).toBe(true);
    expect(getPlayer().elements[0].src).toContain(`${CH1}-seg0`);
    expect(played).toContain(getPlayer().elements[0]);
  });

  it("hands off to the second element on ended without reloading the source", async () => {
    const getPlayer = setup();
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
    const getPlayer = setup();
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
    const getPlayer = setup();
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
    const getPlayer = setup();
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
    const getPlayer = setup();
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
    const getPlayer = setup();
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
});
