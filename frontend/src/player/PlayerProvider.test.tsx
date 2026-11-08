import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerContextValue } from "./PlayerProvider";
import { SILENT_SRC, TTS_LOOKAHEAD, formatSpeed } from "./PlayerProvider";
import { installMockEventSource, MockEventSource } from "../test/eventsource";
import { BOOK_ID, BOOK2_ID, CH1, CH2, CH3, installPlayerFetch, makeProgress, makeSegments, renderPlayer, stubMedia } from "../test/player";
import { deviceLabel } from "../api/progress";
import { DEFAULT_SETTINGS, settingsQueryKey, speedOptionsQueryKey } from "../api/settings";
import type { AudioStatus } from "../api/audio";

let prepareCalls: { segment_id: string; count: number; voice?: string }[] = [];
let played: HTMLMediaElement[] = [];
let paused: HTMLMediaElement[] = [];

beforeEach(() => {
  localStorage.clear();
  installMockEventSource();
  prepareCalls = installPlayerFetch().prepareCalls;
  ({ played, paused } = stubMedia());
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

function SearchProbe() {
  return <p data-testid="search">{useLocation().search}</p>;
}

describe("PlayerProvider", () => {
  it("prepares the current segment plus TTS_LOOKAHEAD and starts playback", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    expect(prepareCalls.some((call) => call.segment_id === `${CH1}-seg0` && call.count === TTS_LOOKAHEAD)).toBe(true);
    expect(getPlayer().element.src).toContain(`${CH1}-seg0`);
    expect(played).toContain(getPlayer().element);
  });

  it("queues the rest of the chapter once playback starts, once per chapter", async () => {
    prepareCalls = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 12), [CH2]: makeSegments(CH2, 12) },
      settings: { voices: { en: "danny-en" } },
    }).prepareCalls;
    const getPlayer = renderPlayer();
    await waitFor(() => expect(getPlayer().settings.voices.en).toBe("danny-en"));
    await loadAndPlay(getPlayer);
    const chapterCalls = () => prepareCalls.filter((call) => call.count > TTS_LOOKAHEAD);
    await waitFor(() => expect(chapterCalls()).toHaveLength(1));
    expect(chapterCalls()[0]).toEqual({ segment_id: `${CH1}-seg0`, count: 12, voice: "danny-en" });

    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    expect(chapterCalls()).toHaveLength(1); // the next segment does not re-queue the chapter

    await act(async () => {
      await getPlayer().goToChapter(CH2);
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(chapterCalls()).toHaveLength(2); // a new chapter queues its own remainder
    expect(chapterCalls()[1]).toEqual({ segment_id: `${CH2}-seg0`, count: 12, voice: "danny-en" });
  });

  it("reloadVoice queues the chapter again for the new voice", async () => {
    prepareCalls = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 12), [CH2]: makeSegments(CH2, 12) },
    }).prepareCalls;
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const chapterCalls = () => prepareCalls.filter((call) => call.count > TTS_LOOKAHEAD);
    await waitFor(() => expect(chapterCalls()).toHaveLength(1));

    act(() => {
      getPlayer().reloadVoice(BOOK_ID);
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    await waitFor(() => expect(chapterCalls()).toHaveLength(2));
    expect(chapterCalls()[1]?.segment_id).toBe(`${CH1}-seg0`);
  });

  it("starts the next clip on the same element inside the ended handler", async () => {
    // With the screen locked iOS only keeps audio going when the element that
    // just ended is told to play again from its own `ended` handler.
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const el = getPlayer().element;
    const callsBefore = prepareCalls.length;
    played.length = 0;
    act(() => {
      el.dispatchEvent(new Event("ended"));
      // Synchronously, before any microtask or network round-trip (the source
      // is the next clip, or its in-memory copy once that has been fetched):
      expect(el.src).toMatch(new RegExp(`${CH1}-seg1$|^blob:`));
      expect(el.src).not.toContain(`${CH1}-seg0`);
      expect(played).toEqual([el]);
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(prepareCalls.length).toBe(callsBefore); // next segment was already known ready
  });

  it("switches to the in-memory copy of the next clip at the boundary", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", Object.assign(class extends URL {}, {
      createObjectURL: () => {
        created.push(`blob:clip${created.length}`);
        return created.at(-1)!;
      },
      revokeObjectURL: (url: string) => void revoked.push(url),
    }));
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    await waitFor(() => expect(created).toEqual(["blob:clip0"])); // segment 1, fetched while 0 plays
    const el = getPlayer().element;
    act(() => {
      el.dispatchEvent(new Event("ended"));
    });
    expect(el.getAttribute("src")).toBe("blob:clip0");
    await waitFor(() => expect(getPlayer().index).toBe(1));
    act(() => getPlayer().stop());
    expect(revoked).toContain("blob:clip0");
  });

  it("a seek that replaces the source while play() is pending is not a failure", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const abort = Promise.reject(new DOMException("interrupted by a new load request", "AbortError"));
    abort.catch(() => undefined);
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(abort);
    act(() => getPlayer().seekSegment(0, 2)); // play() for segment 0 will be aborted…
    act(() => getPlayer().seekSegment(1, 0)); // …because this loads segment 1
    await waitFor(() => expect(getPlayer().index).toBe(1));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
  });

  it("does not start anything when an SSE audio frame tops up while playing", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const playsBefore = played.length;
    await act(async () => {
      MockEventSource.instances[0]!.emit("audio", { book_id: BOOK_ID, segment_id: `${CH1}-seg1` });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let topUp's prepare round-trip settle
    });
    expect(played).toHaveLength(playsBefore); // statuses merged, nothing started
    expect(getPlayer().playing).toBe(true);
    expect(getPlayer().index).toBe(0);
  });

  it("pauses the element and a later play resumes it once", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => getPlayer().pause());
    expect(getPlayer().playing).toBe(false);
    expect(paused).toContain(getPlayer().element);
    played.length = 0;
    await act(async () => {
      getPlayer().toggle();
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(played).toEqual([getPlayer().element]);
  });

  it("resuming while the segment is still generating asks again instead of hanging", async () => {
    prepareCalls = installPlayerFetch({ statuses: { [`${CH1}-seg0`]: "queued" } }).prepareCalls;
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    act(() => getPlayer().toggle());
    await waitFor(() => expect(getPlayer().preparing).toBe(true));
    const before = prepareCalls.filter((call) => call.segment_id === `${CH1}-seg0`).length;

    act(() => getPlayer().pause());
    act(() => getPlayer().toggle());

    // The bug: resume only called pump() and waited for a poll that could be
    // lost, leaving "Preparing audio…" forever. Resume must issue a prepare.
    await waitFor(() =>
      expect(prepareCalls.filter((call) => call.segment_id === `${CH1}-seg0`).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("ended moves to the next segment and starts it exactly once", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const el = getPlayer().element;
    expect(played).toEqual([el]); // nothing else started while playing
    act(() => {
      el.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(played).toEqual([el, el]);
  });

  it("auto-advances to the next chapter when the chapter ends", async () => {
    installPlayerFetch({ segmentsByChapter: { [CH1]: makeSegments(CH1, 1), [CH2]: makeSegments(CH2, 1) } });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    expect(getPlayer().index).toBe(0);
    expect(getPlayer().element.src).toContain(`${CH2}-seg0`);
    await waitFor(() => expect(getPlayer().playing).toBe(true));
  });

  it("applies playback speed, clamps to 0.9–1.15 and rounds to 0.05", () => {
    const getPlayer = renderPlayer();
    const a = getPlayer().element;
    getPlayer().setRate(1.1);
    expect([a.playbackRate, a.defaultPlaybackRate]).toEqual([1.1, 1.1]); // a new src keeps the speed
    getPlayer().setRate(1.13);
    expect(a.playbackRate).toBe(1.15); // rounds to the step, no float noise
    getPlayer().setRate(2);
    expect(a.playbackRate).toBe(1.15);
    getPlayer().setRate(0.5);
    expect(a.playbackRate).toBe(0.9);
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
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
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

  it("keeps refreshing the lookahead statuses while playing so a boundary cannot stall", async () => {
    vi.useFakeTimers();
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
      getPlayer().toggle();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getPlayer().playing).toBe(true);
    const before = prepareCalls.length;

    // The bug: the prepare poll stopped when `preparing` cleared, so a status
    // update lost to an in-flight topUp left the next segment "queued" forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(prepareCalls.length).toBeGreaterThan(before);
    expect(getPlayer().playing).toBe(true); // the heartbeat must not start audio
  });

  it("starts at the saved default speed", async () => {
    installPlayerFetch({ settings: { speed: 1.1 } });
    const getPlayer = renderPlayer();
    await waitFor(() => expect(getPlayer().rate).toBe(1.1));
    expect(getPlayer().element.playbackRate).toBe(1.1);
  });

  it("remembers the speed per book and starts new books at the default", async () => {
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    act(() => getPlayer().setRate(1.1));
    expect(localStorage.getItem(`folio-book-speed-${BOOK_ID}`)).toBe("1.1");
    await act(async () => {
      await getPlayer().load(BOOK2_ID);
    });
    expect(getPlayer().rate).toBe(1); // a book without a stored speed starts at the default
    act(() => getPlayer().setRate(0.95));
    expect(localStorage.getItem(`folio-book-speed-${BOOK2_ID}`)).toBe("0.95");
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().rate).toBe(1.1); // book A keeps its own speed
  });

  it("a Settings default change does not override a book with a stored speed", async () => {
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    act(() => getPlayer().setRate(1.15));
    act(() => getPlayer.client.setQueryData(settingsQueryKey, { ...DEFAULT_SETTINGS, speed: 0.95 }));
    expect(getPlayer().rate).toBe(1.15); // the stored per-book speed wins
    localStorage.removeItem(`folio-book-speed-${BOOK_ID}`);
    act(() => getPlayer.client.setQueryData(settingsQueryKey, { ...DEFAULT_SETTINGS, speed: 1.05 }));
    await waitFor(() => expect(getPlayer().rate).toBe(1.05)); // without one, the default applies
  });

  it("clamps and rounds to the configured grid, not the fallback", async () => {
    installPlayerFetch({ speedOptions: { min: 0.9, max: 1.2, step: 0.1 } });
    const getPlayer = renderPlayer();
    await waitFor(() =>
      expect(getPlayer.client.getQueryData(speedOptionsQueryKey)).toEqual({ min: 0.9, max: 1.2, step: 0.1 }),
    );
    act(() => getPlayer().setRate(1.14));
    expect(getPlayer().rate).toBe(1.1); // nearest position on the config grid
    act(() => getPlayer().setRate(2));
    expect(getPlayer().rate).toBe(1.2); // clamps to the configured max
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

  it("estimates the chapter total from characters while no clip has a measured duration", async () => {
    installPlayerFetch({ duration_s: 0 }); // prepare answers without durations: nothing measured yet
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    const chars = getPlayer().segments.reduce((total, seg) => total + seg.char_end - seg.char_start, 0);
    expect(getPlayer().chapterTotal).toBeGreaterThan(0);
    expect(getPlayer().chapterTotal).toBeCloseTo(chars * (600 / 1200), 5); // the fixture book's measured s/char
    expect(getPlayer().chapterTotalApprox).toBe(true);
    act(() => getPlayer().seekChapter(80)); // 72 s of estimated segment 0, so 80 s is inside segment 1
    expect(getPlayer().index).toBe(1);
    expect(getPlayer().chapterElapsed).toBeCloseTo(80, 5);
  });

  it("counts the measured durations once the chapter has them", async () => {
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().chapterTotal).toBe(20); // two segments of 10 s, no estimate added
    expect(getPlayer().chapterTotalApprox).toBe(false);
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
      getPlayer().element.dispatchEvent(new Event("ended"));
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

  it("the book narrator wins over the per-language preference", async () => {
    const { prepareCalls: calls } = installPlayerFetch({
      book: { narrator_voice: "zoe-en" },
      settings: { voices: { en: "danny-en" } },
    });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    expect(calls.some((call) => call.voice === "zoe-en")).toBe(true);
    expect(calls.every((call) => call.voice !== "danny-en")).toBe(true);
  });

  it("reloadVoice re-prepares the current position and keeps playing", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const before = prepareCalls.length;
    const a = getPlayer().element;
    act(() => {
      a.currentTime = 12;
      a.dispatchEvent(new Event("timeupdate"));
    });
    expect(getPlayer().time).toBe(12);
    await act(async () => {
      getPlayer().reloadVoice(BOOK_ID);
    });
    await waitFor(() => expect(prepareCalls.length).toBeGreaterThan(before));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(getPlayer().preparing).toBe(false); // the buffer gate cleared once it started
    expect(getPlayer().time).toBe(12);
    expect(prepareCalls[prepareCalls.length - 1]?.segment_id).toBe(`${CH1}-seg0`);
  });

  it("reloadVoice waits for the lookahead buffer before resuming", async () => {
    // The stall bug: the current segment alone was enough to start, so playback
    // began and then paused while the queued next segments caught up.
    const statuses: Record<string, AudioStatus> = { [`${CH1}-seg1`]: "queued" };
    prepareCalls = installPlayerFetch({ statuses }).prepareCalls;
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer); // the first start is not gated
    expect(played).toHaveLength(1);

    const before = prepareCalls.length;
    await act(async () => {
      getPlayer().reloadVoice(BOOK_ID);
    });
    await waitFor(() => expect(prepareCalls.length).toBeGreaterThan(before));
    expect(getPlayer().playing).toBe(false);
    expect(getPlayer().preparing).toBe(true);
    expect(played).toHaveLength(1); // nothing started while the buffer is incomplete

    statuses[`${CH1}-seg1`] = "ready";
    await act(async () => {
      MockEventSource.instances[0]!.emit("audio", { book_id: BOOK_ID, segment_id: `${CH1}-seg1` });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the top-up settle
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(getPlayer().preparing).toBe(false);
    expect(played).toHaveLength(2); // and it started exactly once, on the full buffer
  });

  it("reloadVoice keeps a paused player paused without prebuffering", async () => {
    const statuses: Record<string, AudioStatus> = { [`${CH1}-seg1`]: "queued" };
    prepareCalls = installPlayerFetch({ statuses }).prepareCalls;
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => getPlayer().pause());
    played.length = 0;

    await act(async () => {
      getPlayer().reloadVoice(BOOK_ID);
    });
    expect(getPlayer().playing).toBe(false);
    expect(getPlayer().preparing).toBe(false);
    expect(played).toHaveLength(0);
  });

  it("reloadVoice ignores a different book", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const before = prepareCalls.length;
    act(() => getPlayer().reloadVoice(BOOK2_ID));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prepareCalls.length).toBe(before);
  });

  it("unmounting the player (e.g. a lost session leaving for /login) stops the audio", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const el = getPlayer().element;
    paused.length = 0;
    cleanup();
    expect(paused).toContain(el);
  });

  it("stop pauses the element, saves, clears the book, and clears the URL query", async () => {
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer(<SearchProbe />, [`/player?book=${BOOK_ID}`]);
    await loadAndPlay(getPlayer);
    act(() => getPlayer().stop());
    expect(getPlayer().book).toBeNull();
    expect(getPlayer().chapter).toBeNull();
    expect(getPlayer().playing).toBe(false);
    expect(getPlayer().segments).toHaveLength(0);
    expect(paused).toContain(getPlayer().element);
    await waitFor(() => expect(saveCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
  });
});

describe("PlayerProvider progress", () => {
  it("resumes at the saved segment with a 3 s rewind and does not save during resume", async () => {
    const { saveCalls } = installPlayerFetch({ progress: makeProgress({ device_label: deviceLabel() }) });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().index).toBe(1);
    expect(getPlayer().time).toBe(4); // 7 - 3
    expect(saveCalls).toHaveLength(0);
  });

  it("opens the saved chapter before seeking", async () => {
    installPlayerFetch({ progress: makeProgress({ chapter_id: CH2, segment_id: `${CH2}-seg1`, device_label: deviceLabel() }) });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().chapter?.id).toBe(CH2);
    expect(getPlayer().index).toBe(1);
    expect(getPlayer().time).toBe(4);
  });

  it("with no progress starts at the first included chapter, segment 0", async () => {
    installPlayerFetch({
      chapters: [
        { id: CH1, idx: 0, title: "Front matter", char_count: 600, excluded: true },
        { id: CH2, idx: 1, title: "Chapter One", char_count: 600 },
      ],
    });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().chapter?.id).toBe(CH2);
    expect(getPlayer().index).toBe(0);
    expect(getPlayer().time).toBe(0);
  });

  it("starts fresh when the saved chapter has since been excluded", async () => {
    installPlayerFetch({
      chapters: [
        { id: CH1, idx: 0, title: "Front matter", char_count: 600, excluded: true },
        { id: CH2, idx: 1, title: "Chapter One", char_count: 600 },
      ],
      progress: makeProgress({ chapter_id: CH1, segment_id: `${CH1}-seg1`, offset_s: 7, device_label: deviceLabel() }),
    });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().chapter?.id).toBe(CH2); // the first included chapter
    expect(getPlayer().index).toBe(0);
    expect(getPlayer().time).toBe(0);
  });

  it("resumes the saved chapter by its place in the included list, not the raw one", async () => {
    // The 16 % bug: the saved chapter's index was computed on the unfiltered
    // list but applied to the included one, landing an excluded-chapter count
    // deeper into the book.
    installPlayerFetch({
      chapters: [
        { id: CH1, idx: 0, title: "Front matter", char_count: 600, excluded: true },
        { id: CH2, idx: 1, title: "Chapter One", char_count: 600 },
      ],
      progress: makeProgress({ chapter_id: CH2, segment_id: `${CH2}-seg1`, offset_s: 7, device_label: deviceLabel() }),
    });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().chapter?.id).toBe(CH2);
    expect(getPlayer().index).toBe(1);
    expect(getPlayer().time).toBe(4);
  });

  it("switching books resets the position instead of carrying it over", async () => {
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    await act(async () => {
      getPlayer().seekSegment(1, 5);
    });
    expect(getPlayer().index).toBe(1);
    await act(async () => {
      await getPlayer().load(BOOK2_ID);
    });
    expect(getPlayer().book?.id).toBe(BOOK2_ID);
    expect(getPlayer().chapter?.id).toBe(CH3);
    expect(getPlayer().index).toBe(0);
    expect(getPlayer().time).toBe(0);
  });

  it("saves every 10 s while playing and restarts the timer on each save", async () => {
    vi.useFakeTimers();
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
      getPlayer().toggle();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(saveCalls).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({ chapter_id: CH1, segment_id: `${CH1}-seg0` });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(saveCalls).toHaveLength(2);
  });

  it("saves on pause", async () => {
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    expect(saveCalls).toHaveLength(0);
    act(() => getPlayer().pause());
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({ segment_id: `${CH1}-seg0`, device_label: deviceLabel() });
  });

  it("refreshes the progress cache and invalidates book and continue after a save", async () => {
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer();
    const invalidate = vi.spyOn(getPlayer.client, "invalidateQueries");
    await loadAndPlay(getPlayer);
    act(() => getPlayer().pause());
    expect(saveCalls).toHaveLength(1);
    // The silent save must still update what the book page badge, the cover
    // badges and the Continue row read.
    await waitFor(() =>
      expect(getPlayer.client.getQueryData(["progress", BOOK_ID])).toMatchObject({ percent: 50 }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["book", BOOK_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["continue"] });
  });

  it("saves on segment change", async () => {
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    expect(saveCalls.some((call) => call.segment_id === `${CH1}-seg1`)).toBe(true);
  });

  it("saves on chapter change", async () => {
    const fixture = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 1), [CH2]: makeSegments(CH2, 1) },
    });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    expect(fixture.saveCalls.some((call) => call.chapter_id === CH1)).toBe(true);
  });

  it("saves when the tab hides and on pagehide", async () => {
    const { saveCalls } = installPlayerFetch();
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(saveCalls).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveCalls).toHaveLength(2);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("stays silent on a failed save and retries on the next tick", async () => {
    vi.useFakeTimers();
    const fixture = installPlayerFetch();
    fixture.saveFails = true;
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
      getPlayer().toggle();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fixture.saveCalls).toHaveLength(1);
    expect(getPlayer().error).toBeNull();
    expect(getPlayer().playing).toBe(true);
    fixture.saveFails = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fixture.saveCalls).toHaveLength(2);
  });

  it("marks the book finished once when the last segment of the last chapter ends", async () => {
    const fixture = installPlayerFetch({
      segmentsByChapter: { [CH1]: makeSegments(CH1, 1), [CH2]: makeSegments(CH2, 1) },
    });
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().chapter?.id).toBe(CH2));
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().finished).toBe(true));
    expect(getPlayer().playing).toBe(false);
    await waitFor(() => expect(fixture.finishedCalls).toEqual([{ finished: true }]));
  });

  it("prompts when another device is more than 60 s ahead", async () => {
    localStorage.setItem(
      `folio-pos-${BOOK_ID}`,
      JSON.stringify(makeProgress({ percent: 10, segment_id: `${CH1}-seg0`, offset_s: 0 })),
    );
    installPlayerFetch({ progress: makeProgress({ percent: 21, device_label: "Windows PC 9f9f" }) });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().resumePrompt?.device).toBe("Windows PC 9f9f");
    expect(getPlayer().resumePrompt?.chapter).toBe("Chapter One");
    act(() => getPlayer().resumePrompt?.onContinue());
    expect(getPlayer().time).toBe(4); // the server position, rewound 3 s
    expect(getPlayer().resumePrompt).toBeNull();
  });

  it("Start here resumes from this device's remembered position", async () => {
    localStorage.setItem(
      `folio-pos-${BOOK_ID}`,
      JSON.stringify(makeProgress({ percent: 10, segment_id: `${CH1}-seg1`, offset_s: 21 })),
    );
    installPlayerFetch({ progress: makeProgress({ percent: 21, device_label: "Windows PC 9f9f" }) });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    act(() => getPlayer().resumePrompt?.onStartHere());
    expect(getPlayer().time).toBe(18); // 21 - 3
  });

  it("resumes silently when the other device is within 60 s ahead", async () => {
    localStorage.setItem(`folio-pos-${BOOK_ID}`, JSON.stringify(makeProgress({ percent: 10 })));
    installPlayerFetch({ progress: makeProgress({ percent: 20, device_label: "Windows PC 9f9f" }) }); // 10% of 600 s = 60 s
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().resumePrompt).toBeNull();
    expect(getPlayer().time).toBe(4);
  });

  it("resumes silently when this device has no remembered position", async () => {
    installPlayerFetch({ progress: makeProgress({ percent: 95, device_label: "Windows PC 9f9f" }) });
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    expect(getPlayer().resumePrompt).toBeNull();
    expect(getPlayer().time).toBe(4);
  });

  it("exposes character-based progressPercent", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    expect(getPlayer().progressPercent).toBe(0);
    act(() => {
      getPlayer().element.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    // Segment one starts at its char_start of the 1200-char book.
    expect(getPlayer().progressPercent).toBeCloseTo(makeSegments(CH1, 2)[1]!.char_start / 12, 5);
  });
});

describe("PlayerProvider on iOS", () => {
  it("unlocks the element on the first play gesture, before the network", async () => {
    // iOS blocks play() on an element that has never played from a gesture, and
    // play() only reaches the audio after a prepare round-trip.
    prepareCalls = installPlayerFetch({ statuses: { [`${CH1}-seg0`]: "generating" } }).prepareCalls;
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    act(() => void getPlayer().play());
    expect(getPlayer().element.getAttribute("src")).toBe(SILENT_SRC);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The silent clip is gone again (restored to empty) and is not playback.
    expect(getPlayer().element.getAttribute("src")).toBe("");
    expect(getPlayer().playing).toBe(false);
  });

  it("the unlock clip never stands in for real audio", async () => {
    const getPlayer = renderPlayer();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    await act(async () => {
      await getPlayer().play(); // unlock + real audio in the same tap
    });
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(getPlayer().element.src).toContain(`${CH1}-seg0`);
  });

  it("publishes the chapter duration and position to the lock screen", async () => {
    const setPositionState = vi.fn();
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: { playbackState: "none", metadata: null, setActionHandler: vi.fn(), setPositionState },
    });
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      await waitFor(() => expect(setPositionState).toHaveBeenCalled());
      act(() => getPlayer().seekSegment(1, 3)); // segment 1 starts 10 s into the chapter
      await waitFor(() =>
        expect(setPositionState.mock.calls.at(-1)![0]).toMatchObject({ position: expect.closeTo(13, 0) }),
      );
      const state = setPositionState.mock.calls.at(-1)![0] as MediaPositionState;
      expect(state.duration).toBe(20); // the chapter's two segments, not the 10 s clip iOS would use
      expect(state.duration).toBeGreaterThan(10);
      expect(state.playbackRate).toBe(1);
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  /** A plain mediaSession stand-in that counts metadata assignments. */
  function installMediaSession() {
    const session = {
      playbackState: "none" as MediaSessionPlaybackState,
      metadataWrites: 0,
      _metadata: null as unknown,
      get metadata() {
        return this._metadata;
      },
      set metadata(value: unknown) {
        this.metadataWrites += 1;
        this._metadata = value;
      },
      setActionHandler: vi.fn(),
      setPositionState: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
    vi.stubGlobal(
      "MediaMetadata",
      class {
        constructor(init: object) {
          Object.assign(this, init);
        }
      },
    );
    return session;
  }

  it("sets the lock-screen metadata once instead of on every playback second", async () => {
    // A fresh MediaMetadata makes iOS reload the artwork: the cover flickered.
    const session = installMediaSession();
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      const writes = session.metadataWrites;
      expect(writes).toBeGreaterThan(0);
      const a = getPlayer().element;
      for (const t of [1, 2, 3, 4]) {
        a.currentTime = t;
        act(() => {
          a.dispatchEvent(new Event("timeupdate"));
        });
      }
      expect(session.setPositionState.mock.calls.at(-1)![0]).toMatchObject({ position: 4 });
      expect(session.metadataWrites).toBe(writes);
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  it("an iOS-initiated pause stops the player and the lock-screen clock", async () => {
    // Interruptions (calls, Siri, route changes) pause the element directly; the
    // lock screen kept extrapolating while the app still thought it was playing.
    const session = installMediaSession();
    const installed = installPlayerFetch();
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      expect(session.playbackState).toBe("playing");
      const a = getPlayer().element;
      a.currentTime = 6;
      const saves = installed.saveCalls.length;
      act(() => {
        a.dispatchEvent(new Event("pause"));
      });
      expect(getPlayer().playing).toBe(false);
      expect(session.playbackState).toBe("paused");
      expect(session.setPositionState.mock.calls.at(-1)![0]).toMatchObject({ position: 6 });
      await waitFor(() => expect(installed.saveCalls.length).toBeGreaterThan(saves));
      expect(installed.saveCalls.at(-1)).toMatchObject({ offset_s: 6 });

      // The lock-screen play button must work again afterwards.
      const starts = played.length;
      await act(async () => {
        await getPlayer().play();
      });
      await waitFor(() => expect(getPlayer().playing).toBe(true));
      expect(played.length).toBeGreaterThan(starts);
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  it("a buffering stall pauses the lock-screen clock until audio flows again", async () => {
    const session = installMediaSession();
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      const a = getPlayer().element;
      a.currentTime = 5; // mid-clip: the load at a clip boundary is not a stall
      act(() => {
        a.dispatchEvent(new Event("waiting"));
      });
      expect(session.playbackState).toBe("paused");
      expect(getPlayer().playing).toBe(true); // still the listener's intent; not a pause
      act(() => {
        a.dispatchEvent(new Event("playing"));
      });
      expect(session.playbackState).toBe("playing");
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  it("keeps the lock screen on playing across a clip boundary", async () => {
    const session = installMediaSession();
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      const states: string[] = [];
      let value = session.playbackState;
      Object.defineProperty(session, "playbackState", {
        get: () => value,
        set: (next: MediaSessionPlaybackState) => {
          value = next;
          states.push(next);
        },
      });
      act(() => {
        getPlayer().element.dispatchEvent(new Event("ended"));
      });
      await waitFor(() => expect(getPlayer().index).toBe(1));
      await waitFor(() => expect(getPlayer().playing).toBe(true));
      expect(states).not.toContain("paused");
      expect(session.playbackState).toBe("playing");
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  it("shows paused on the lock screen the moment a boundary waits on generation", async () => {
    installPlayerFetch({ statuses: { [`${CH1}-seg1`]: "generating" } });
    const session = installMediaSession();
    try {
      const getPlayer = renderPlayer();
      await loadAndPlay(getPlayer);
      expect(session.playbackState).toBe("playing");
      act(() => {
        getPlayer().element.dispatchEvent(new Event("ended"));
        // Synchronously: a locked screen may not render again for a long time.
        expect(session.playbackState).toBe("paused");
      });
      await waitFor(() => expect(getPlayer().preparing).toBe(true));
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
    }
  });

  it("after a generation stall, waits for a buffer before resuming", async () => {
    // Resuming on the first ready segment stalled again a few seconds later.
    const fixture: { statuses: Record<string, AudioStatus>; segmentsByChapter: Record<string, ReturnType<typeof makeSegments>> } = {
      statuses: { [`${CH1}-seg1`]: "generating", [`${CH1}-seg2`]: "queued", [`${CH1}-seg3`]: "queued" },
      segmentsByChapter: { [CH1]: makeSegments(CH1, 6), [CH2]: makeSegments(CH2, 2) },
    };
    installPlayerFetch(fixture);
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const el = getPlayer().element;
    act(() => {
      el.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().preparing).toBe(true));
    const frame = async () => {
      await act(async () => {
        MockEventSource.instances[0]!.emit("audio", { book_id: BOOK_ID, segment_id: `${CH1}-seg1` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    delete fixture.statuses[`${CH1}-seg1`]; // the stalled segment is ready…
    await frame();
    expect(getPlayer().playing).toBe(false); // …but nothing behind it yet
    expect(getPlayer().preparing).toBe(true);

    delete fixture.statuses[`${CH1}-seg2`];
    delete fixture.statuses[`${CH1}-seg3`];
    await frame();
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    expect(getPlayer().index).toBe(1);
  });

  it("ignores the pause event that precedes ended at a clip boundary", async () => {
    const getPlayer = renderPlayer();
    await loadAndPlay(getPlayer);
    const a = getPlayer().element;
    vi.spyOn(a, "ended", "get").mockReturnValue(true);
    act(() => {
      a.dispatchEvent(new Event("pause"));
      a.dispatchEvent(new Event("ended"));
    });
    await waitFor(() => expect(getPlayer().index).toBe(1));
    expect(getPlayer().playing).toBe(true);
  });
});

describe("formatSpeed", () => {
  it("shows one decimal minimum and two only when needed", () => {
    expect(formatSpeed(0.9)).toBe("0.9");
    expect(formatSpeed(1)).toBe("1.0");
    expect(formatSpeed(1.1)).toBe("1.1"); // Math.round guards float noise like 1.1 * 100 !== 110
    expect(formatSpeed(1.15)).toBe("1.15");
  });
});
