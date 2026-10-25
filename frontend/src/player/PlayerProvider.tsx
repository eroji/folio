/** Player state machine (plan Task C): two <audio> elements with a handoff
 * swap on `ended`, lookahead prepare, chapter auto-advance, sleep timer,
 * Media Session and /player URL sync. Never writes progress (M5). */
import { createContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { fetchBookDetail, fetchSegments, prepareAudio, type PreparedSegment, type Segment } from "../api/audio";
import type { Book, Chapter } from "../api/types";

/** TTS_LOOKAHEAD, spec "Generation strategy". */
export const TTS_LOOKAHEAD = 6;
export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2.5;
const SPEED_STEP = 0.25;
const POLL_MS = 1000;

export type SleepChoice = "chapter" | number | null;

export interface PlayerContextValue {
  book: Book | null;
  chapters: Chapter[];
  chapter: Chapter | null;
  segments: Segment[];
  index: number;
  segment: Segment | null;
  status: Record<string, PreparedSegment>;
  playing: boolean;
  preparing: boolean;
  error: string | null;
  /** Seconds played within the current segment. */
  time: number;
  rate: number;
  sleep: SleepChoice;
  chapterElapsed: number;
  chapterDuration: number;
  elements: readonly [HTMLAudioElement, HTMLAudioElement];
  load: (bookId: string, chapterId?: string) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => void;
  seekChapter: (seconds: number) => void;
  seekSegment: (index: number, offsetSeconds: number) => void;
  skip: (deltaSeconds: number) => void;
  stepChapter: (delta: number) => Promise<void>;
  goToChapter: (chapterId: string) => void;
  setRate: (rate: number) => void;
  setSleep: (choice: SleepChoice) => void;
  retry: () => void;
}

export const PlayerContext = createContext<PlayerContextValue | null>(null);

interface Machine {
  book: Book | null;
  chapters: Chapter[];
  chapterIdx: number;
  segments: Segment[];
  index: number;
  status: Record<string, PreparedSegment>;
  intent: boolean; // the user wants audio playing
  playing: boolean;
  preparing: boolean;
  error: string | null;
  time: number;
  rate: number;
  sleep: SleepChoice;
  offset: number; // seconds to seek to when the current segment starts
  active: 0 | 1;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const s = useRef<Machine>({
    book: null, chapters: [], chapterIdx: 0, segments: [], index: 0, status: {},
    intent: false, playing: false, preparing: false, error: null,
    time: 0, rate: 1, sleep: null, offset: 0, active: 0,
  }).current;
  const els = useMemo(() => [new Audio(), new Audio()] as const, []);
  const sleepTimer = useRef<number | null>(null);

  const activeEl = () => (s.active === 0 ? els[0] : els[1]);
  const idleEl = () => (s.active === 0 ? els[1] : els[0]);
  const currentItem = () => s.status[s.segments[s.index]?.id ?? ""];
  const durationOf = (segment: Segment | undefined) => (segment ? s.status[segment.id]?.duration_s ?? 0 : 0);
  const chapterTotal = () => s.segments.reduce((total, seg) => total + durationOf(seg), 0);
  const elapsed = () => s.segments.slice(0, s.index).reduce((total, seg) => total + durationOf(seg), 0) + s.time;

  function fail(message: string) {
    s.preparing = false;
    s.error = message;
  }

  /** Start/continue the current segment in the right element. `playing` means
   * a handoff: begin in the idle (preloaded) element and swap. */
  function pump() {
    if (!s.intent) return;
    const item = currentItem();
    if (item?.status === "failed") {
      s.intent = false;
      s.playing = false;
      fail("Couldn't generate this part");
      return;
    }
    if (item?.status !== "ready" || !item.url) {
      s.preparing = true;
      return;
    }
    const target = s.playing ? idleEl() : activeEl();
    if (!target.src.includes(item.url)) target.src = item.url;
    if (s.offset > 0) {
      target.currentTime = s.offset;
      s.offset = 0;
    }
    target.playbackRate = s.rate;
    void target
      .play()
      .then(() => {
        s.active = target === els[0] ? 0 : 1;
        s.playing = true;
        s.preparing = false;
        s.error = null;
        preloadNext();
        bump();
      })
      .catch(() => {
        s.intent = false;
        s.playing = false;
        bump();
      });
  }

  /** Point the idle element at the next segment so `ended` can hand off without a reload. */
  function preloadNext() {
    const item = s.status[s.segments[s.index + 1]?.id ?? ""];
    if (item?.status === "ready" && item.url) {
      const idle = idleEl();
      if (!idle.src.includes(item.url)) {
        idle.src = item.url;
        idle.currentTime = 0;
      }
      idle.playbackRate = s.rate;
    }
  }

  /** prepare for the current segment + lookahead, merge statuses, retry the pump. */
  async function topUp() {
    const segment = s.segments[s.index];
    if (!s.book || !segment) return;
    try {
      const res = await prepareAudio(s.book.id, segment.id, TTS_LOOKAHEAD);
      s.status = { ...s.status, ...Object.fromEntries(res.items.map((item) => [item.segment_id, item])) };
      preloadNext();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not reach the server.");
    }
    pump();
    bump();
  }

  async function openChapter(idx: number, autoplay: boolean) {
    const book = s.book;
    const chapter = s.chapters[idx];
    if (!book || !chapter) return;
    s.chapterIdx = idx;
    s.segments = [];
    s.index = 0;
    s.status = {};
    s.time = 0;
    s.offset = 0;
    s.error = null;
    s.preparing = autoplay;
    bump();
    try {
      s.segments = await queryClient.fetchQuery({
        queryKey: ["segments", book.id, chapter.id],
        queryFn: () => fetchSegments(book.id, chapter.id),
      });
    } catch (error) {
      s.intent = false;
      s.preparing = false;
      fail(error instanceof Error ? error.message : "Could not reach the server.");
      bump();
      return;
    }
    if (autoplay) s.intent = true;
    await topUp();
  }

  function handleEnded() {
    s.time = 0;
    if (s.index + 1 < s.segments.length) {
      s.index += 1;
      s.offset = 0;
      if (currentItem()?.status === "ready") pump();
      else void topUp();
    } else {
      if (s.sleep === "chapter") s.intent = false;
      void advanceChapter();
    }
    bump();
  }

  async function advanceChapter() {
    if (!s.intent || s.chapterIdx + 1 >= s.chapters.length) {
      s.intent = false;
      s.playing = false;
      s.preparing = false;
      bump();
      return;
    }
    await openChapter(s.chapterIdx + 1, true);
  }

  async function load(bookId: string, chapterId?: string) {
    if (s.book?.id === bookId && s.segments.length > 0 && (!chapterId || s.chapters[s.chapterIdx]?.id === chapterId)) return;
    try {
      const detail = await queryClient.fetchQuery({ queryKey: ["book", bookId], queryFn: () => fetchBookDetail(bookId) });
      s.book = detail.book;
      s.chapters = detail.chapters;
      const idx = chapterId ? Math.max(0, detail.chapters.findIndex((c) => c.id === chapterId)) : 0;
      await openChapter(idx, false);
    } catch (error) {
      s.error = error instanceof Error ? error.message : "Could not reach the server.";
      bump();
    }
  }

  async function play() {
    s.intent = true;
    if (!s.book) {
      const id = new URLSearchParams(location.search).get("book");
      if (!id) return;
      await load(id);
    }
    if (currentItem()) pump();
    else await topUp();
    bump();
  }

  function pause() {
    s.intent = false;
    s.playing = false;
    activeEl().pause();
    bump();
  }

  function toggle() {
    if (s.intent) pause();
    else void play();
  }

  /** Seek to a segment + offset within it; prepares first when unknown. */
  function seekSegment(index: number, offsetSeconds: number) {
    if (index < 0 || index >= s.segments.length) return;
    s.index = index;
    s.offset = Math.max(0, offsetSeconds);
    s.time = s.offset;
    // Prepare the target first so the UI shows "Preparing audio…" instead of silence.
    if (currentItem()?.status === "ready") pump();
    else void topUp();
    bump();
  }

  function seekChapter(seconds: number) {
    const total = chapterTotal();
    if (total <= 0) return;
    const target = Math.min(Math.max(0, seconds), total);
    let acc = 0;
    for (let i = 0; i < s.segments.length; i += 1) {
      const d = durationOf(s.segments[i]);
      if (target < acc + d || i === s.segments.length - 1) {
        seekSegment(i, target - acc);
        return;
      }
      acc += d;
    }
  }

  function skip(deltaSeconds: number) {
    seekChapter(elapsed() + deltaSeconds);
  }

  async function stepChapter(delta: number) {
    const idx = Math.min(Math.max(0, s.chapterIdx + delta), s.chapters.length - 1);
    if (idx !== s.chapterIdx) await openChapter(idx, s.intent);
  }

  function goToChapter(chapterId: string) {
    const idx = s.chapters.findIndex((c) => c.id === chapterId);
    if (idx >= 0 && idx !== s.chapterIdx) void stepChapter(idx - s.chapterIdx);
  }

  function setRate(rate: number) {
    s.rate = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(rate / SPEED_STEP) * SPEED_STEP));
    for (const element of els) element.playbackRate = s.rate;
    bump();
  }

  function setSleep(choice: SleepChoice) {
    if (sleepTimer.current !== null) window.clearTimeout(sleepTimer.current);
    sleepTimer.current = null;
    s.sleep = choice;
    if (typeof choice === "number") {
      sleepTimer.current = window.setTimeout(() => {
        sleepTimer.current = null;
        pause();
      }, choice * 60_000);
    }
    bump();
  }

  function retry() {
    s.error = null;
    void topUp();
  }

  // Latest closures for the stable effects below (state lives in `s`, not closures).
  const fns = useRef({ topUp, play, pause, skip, stepChapter, handleEnded });
  fns.current = { topUp, play, pause, skip, stepChapter, handleEnded };

  useEffect(() => {
    const onEnded = (event: Event) => {
      if (event.target === activeEl()) fns.current.handleEnded();
    };
    const onTime = (event: Event) => {
      const source = event.target as HTMLMediaElement;
      if (source === activeEl()) {
        s.time = source.currentTime;
        bump();
      }
    };
    for (const element of els) {
      element.addEventListener("ended", onEnded);
      element.addEventListener("timeupdate", onTime);
    }
    return () => {
      for (const element of els) {
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("timeupdate", onTime);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- els and the s ref are stable; handlers read live state through them
  }, [els]);

  // Poll prepare while waiting on generation (SSE `audio` frames accelerate it).
  useEffect(() => {
    if (!(s.intent && s.preparing)) return;
    const timer = window.setInterval(() => void fns.current.topUp(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [s.intent, s.preparing]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    // ponytail: second EventSource (useEvents owns the first); consolidate if connection count ever matters.
    const source = new EventSource("/api/v1/events");
    source.addEventListener("audio", () => {
      if (s.book) void fns.current.topUp();
    });
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- s is a stable ref; handler reads through fns
  }, []);

  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const handlers: [string, () => void][] = [
      ["play", () => void fns.current.play()],
      ["pause", () => fns.current.pause()],
      ["seekbackward", () => fns.current.skip(-15)],
      ["seekforward", () => fns.current.skip(30)],
      ["previoustrack", () => void fns.current.stepChapter(-1)],
      ["nexttrack", () => void fns.current.stepChapter(1)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action as MediaSessionAction, handler);
      } catch {
        /* action unsupported in this browser */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action as MediaSessionAction, null);
        } catch {
          /* action unsupported in this browser */
        }
      }
    };
  }, []);

  const book = s.book;
  const chapterTitle = s.chapters[s.chapterIdx]?.title;
  const playing = s.playing;
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = playing ? "playing" : "paused";
    if (book && typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title: chapterTitle ?? book.title,
        artist: book.authors.join(", "),
        album: book.title,
        artwork: book.cover_url ? [{ src: book.cover_url }] : [],
      });
    }
  }, [book, chapterTitle, playing]);

  const syncBookId = book?.id;
  const syncChapterId = s.chapters[s.chapterIdx]?.id;
  useEffect(() => {
    if (location.pathname !== "/player" || !syncBookId) return;
    const search = new URLSearchParams({ book: syncBookId });
    if (syncChapterId) search.set("chapter", syncChapterId);
    if (location.search !== `?${search}`) navigate(`/player?${search}`, { replace: true });
  }, [location.pathname, location.search, syncBookId, syncChapterId, navigate]);

  const value: PlayerContextValue = {
    book: s.book,
    chapters: s.chapters,
    chapter: s.chapters[s.chapterIdx] ?? null,
    segments: s.segments,
    index: s.index,
    segment: s.segments[s.index] ?? null,
    status: s.status,
    playing: s.playing,
    preparing: s.preparing,
    error: s.error,
    time: s.time,
    rate: s.rate,
    sleep: s.sleep,
    chapterElapsed: elapsed(),
    chapterDuration: chapterTotal(),
    elements: els,
    load,
    play,
    pause,
    toggle,
    seekChapter,
    seekSegment,
    skip,
    stepChapter,
    goToChapter,
    setRate,
    setSleep,
    retry,
  };

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
