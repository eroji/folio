/** Player state machine (plan Task C): one <audio> element that loads the next
 * clip from its `ended` handler (iOS ties the lock screen to one element), the
 * next clip fetched into memory ahead of time, lookahead prepare, chapter auto-advance, sleep timer,
 * Media Session and /player URL sync. Progress (plan Task Q): saves every
 * 10 s while playing and on pause/segment change/chapter change/hide,
 * resumes with a 3 s rewind, and prompts when another device is >60 s ahead. */
import { createContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  fetchAudioClip,
  fetchBookDetail,
  fetchSegments,
  fetchStreamTimeline,
  prepareAudio,
  startLive,
  streamPlaylistUrl,
  type PreparedSegment,
  type Segment,
  type StreamEntry,
} from "../api/audio";
import { baseLanguage } from "../api/voices";
import {
  continueQueryKey,
  deviceLabel,
  markFinished,
  progressQueryKey,
  readPosition,
  rememberPosition,
  saveProgress,
  secondsAhead,
} from "../api/progress";
import {
  readBookSpeed,
  snapSpeed,
  useListeningSettings,
  useSpeedOptions,
  writeBookSpeed,
  type ListeningSettings,
} from "../api/settings";
import type { ResumePromptProps } from "../components/ResumePrompt";
import type { Book, BookDetailResponse, Chapter, Progress } from "../api/types";
import { forgetClosed, rememberClosed } from "./closed";
import { sentenceStartFraction, timeForFraction } from "./marks";

/** A live start (POST /audio/live): the current segment plays from `url`
 * while the server makes it. `from` is the share of its text the stream
 * starts at; `estimate` is the segment length the clock runs on until the clip
 * exists (the old voice's, else a character estimate), `base` where the stream
 * starts on that clock. */
interface LiveState {
  segment: string;
  url: string;
  from: number;
  estimate: number;
  base: number;
}

/** TTS_LOOKAHEAD, spec "Generation strategy". */
export const TTS_LOOKAHEAD = 6;

/** Speed as a label number: one decimal minimum, two only when needed
 * (1 → "1.0", 1.1 → "1.1", 1.15 → "1.15"). Callers append the "×". */
export function formatSpeed(value: number): string {
  const hundredths = Math.round(value * 100);
  return (hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2);
}
const POLL_MS = 1000;
/** While playing, refresh the lookahead statuses on a slow beat: an SSE frame
 * that lands during an in-flight topUp is dropped by the in-flight guard, and
 * a stale "queued" for the next segment stalls playback at the boundary. */
const PLAYING_POLL_MS = 5000;
/** Segments after the current one that must be ready before a resume after
 * playback ran into a segment still generating starts: starting on the first
 * one alone made playback stall a few seconds later while the queued lookahead
 * caught up. A voice change does not wait on this (DECISIONS.md). */
const BUFFER_AHEAD = 2;
/** Spec "Progress model": save every 10 s while playing. */
const SAVE_MS = 10_000;
/** Rewind on resume so the listener gets context. */
const REWIND_S = 3;
/** Prompt only when the other device is more than this far ahead. */
const AHEAD_PROMPT_S = 60;
/** 10 ms of silence (8-bit PCM mono). iOS only lets an <audio> element play
 * from a user gesture until that element has played once, and play() reaches
 * the network before it reaches the element, so the first tap fires this clip
 * through the element to unlock it. */
export const SILENT_SRC =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** Refresh a growing stream's timeline at most this often while playing near its end. */
const TIMELINE_REFRESH_MS = 5000;
/** How close to a chapter's end the stream pauses when the chapter should stop. */
const CHAPTER_STOP_S = 0.35;

/** m:ss, or h:mm:ss past an hour; shared by the player screens. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

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
  /** While preparing: sentences of the awaited segment synthesized so far
   * (from the worker's SSE frames); null before the first frame. */
  preparingProgress: { done: number; total: number } | null;
  error: string | null;
  /** Seconds played within the current segment. */
  time: number;
  /** While the current segment has no clip in the new voice after a voice
   * change: the share of its text being spoken (held where playback restarts
   * while waiting; following a live stream's clock while it plays). Read-along
   * uses it, since with no clip length `time` cannot be placed. */
  swapShare: number | null;
  rate: number;
  sleep: SleepChoice;
  /** The user's synced listening settings (speed drives `rate`). */
  settings: ListeningSettings;
  /** The last segment of the last chapter ended (or the saved row is finished). */
  finished: boolean;
  /** Whole-book percent from character positions, never audio duration. */
  progressPercent: number;
  /** Non-null while another device's saved position is >60 s ahead. */
  resumePrompt: ResumePromptProps | null;
  /** Set while the loaded position came from another device (handoff "Other devices"). */
  lastDevice: { label: string; at: string } | null;
  /** Seconds played within the current chapter. */
  chapterElapsed: number;
  /** Sum of the current chapter's segment durations, in seconds: measured where
   * the clip exists, estimated from character counts where it does not. */
  chapterTotal: number;
  /** True while any of the chapter's durations is still a character estimate. */
  chapterTotalApprox: boolean;
  /** The single audio element every clip plays through. */
  element: HTMLAudioElement;
  /** Seconds played within the current segment, read live from the element
   * (the provider's `time` only moves on the throttled timeupdate). */
  liveTime: () => number;
  load: (bookId: string, chapterId?: string) => Promise<void>;
  /** Re-synthesize the current position after a narrator/voice change. */
  reloadVoice: (bookId?: string) => void;
  play: () => Promise<void>;
  pause: () => void;
  /** Pause, save, forget the book, and clear the URL query. */
  stop: () => void;
  toggle: () => void;
  seekChapter: (seconds: number) => void;
  seekSegment: (index: number, offsetSeconds: number) => void;
  skip: (deltaSeconds: number) => void;
  /** Skip by the user's configured back/forward intervals. */
  skipBack: () => void;
  skipForward: () => void;
  stepChapter: (delta: number) => Promise<void>;
  goToChapter: (chapterId: string) => Promise<void>;
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
  prebuffering: boolean; // a resume after a generation stall is filling its lookahead before starting
  progress: Record<string, { done: number; total: number }>; // segment id → sentences synthesized
  error: string | null;
  time: number;
  rate: number;
  sleep: SleepChoice;
  offset: number; // seconds to seek to when the current segment starts
  /** The clip URL (as prepare returned it) the element holds; its `src` may be
   * an in-memory copy of it. Null while the element holds something else. */
  loaded: string | null;
  /** The active element is buffering (`waiting`): the lock-screen clock must stop. */
  stalled: boolean;
  /** Voice the server offers the book as one HLS stream in (null: clip by clip). */
  streamVoice: string | null;
  /** The HLS stream the element plays, when the browser can (Safari / iOS). */
  stream: StreamState | null;
  /** Chapter whose end already paused the stream (stop-at-chapter-end), so the
   * resume that follows does not pause again on the same boundary. */
  chapterStop: string | null;
  /** Chapter just played to its end: the next save marks it listened (and
   * its next visit starts over). Cleared by any move inside a chapter. */
  chapterDone: string | null;
  /** After a voice change: the share of the segment's text to restart at once
   * the new voice's clip (and its length) is known. */
  voiceSwap: { segment: string; fraction: number } | null;
  /** Clip lengths from the voice before a voice change, used until the new
   * voice's are known: the chapter clock keeps counting what was heard instead
   * of falling back to character estimates (the played time would jump). */
  pastDurations: Record<string, number>;
  live: LiveState | null;
  resumeLoading: boolean; // resume not applied yet: saves stay quiet
  finished: boolean;
  finishedMarked: boolean; // the finished PUT fires once per session
  resumePrompt: ResumePromptProps | null;
  lastDevice: { label: string; at: string } | null;
}

/** One HLS book stream: Safari plays the clips from `origin` on as a single
 * track, so no page JavaScript has to run at clip or chapter boundaries
 * while a locked iPhone has frozen the page. `entries` maps stream time to
 * segments; it grows with the playlist until `complete`. */
interface StreamState {
  origin: string;
  voice: string;
  url: string;
  entries: StreamEntry[];
  complete: boolean;
  /** A seek to re-apply once the stream's metadata loads (Safari may drop an early one). */
  pendingSeek: number | null;
  fetchedAt: number;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { settings } = useListeningSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { options: speedOptions } = useSpeedOptions();
  const speedOptionsRef = useRef(speedOptions);
  speedOptionsRef.current = speedOptions;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const s = useRef<Machine>({
    book: null, chapters: [], chapterIdx: 0, segments: [], index: 0, status: {},
    intent: false, playing: false, preparing: false, prebuffering: false, progress: {}, error: null,
    time: 0, rate: 1, sleep: null, offset: 0, loaded: null, stalled: false, streamVoice: null, stream: null, chapterStop: null, chapterDone: null, voiceSwap: null, pastDurations: {}, live: null,
    resumeLoading: false, finished: false, finishedMarked: false, resumePrompt: null, lastDevice: null,
  }).current;
  const el = useMemo(() => new Audio(), []);
  /** Clip URL → object URL of a copy fetched ahead, so the `ended` handler
   * switches clips without a network round-trip. Holds the next clip only. */
  const clips = useRef(new Map<string, string>());
  const fetchingClip = useRef<string | null>(null);
  const sleepTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  /** The last page before /player, so "Stop and close" can return to it. */
  const lastPath = useRef<string | null>(null);

  const currentItem = () => s.status[s.segments[s.index]?.id ?? ""];
  /** The book stream is for Apple's WebKit (Safari, and every iOS browser),
   * whose locked screen freezes the page between clips. Desktop Chrome and Edge
   * also play HLS natively now, but treat the growing EVENT playlist as live:
   * they joined it near the end, waited on it and could not seek. Their UA
   * carries "Chrome/" (iOS Chrome says "CriOS/", iOS Edge "EdgiOS/"). */
  const hlsPlayable = () =>
    el.canPlayType("application/vnd.apple.mpegurl") !== "" &&
    !/\b(?:Chrome|Chromium|Edg|OPR|Firefox)\//.test(navigator.userAgent);
  /** The element is playing (or holds) the book stream. */
  const streaming = () => s.stream !== null && s.loaded === s.stream.url;
  /** Forget the stream. The element may still hold it and fire one more
   * timeupdate (pausing queues one) on the stream's clock, which must never be
   * read as an offset into the current segment: let go of it too. */
  const dropStream = () => {
    if (streaming()) s.loaded = null;
    s.stream = null;
  };
  const entryIndexOf = (segmentId: string | undefined) =>
    s.stream && segmentId ? s.stream.entries.findIndex((e) => e.segment_id === segmentId) : -1;
  /** Index of the stream entry playing at stream time `t`, or -1 past the listed run. */
  const entryAt = (t: number) => {
    const entries = s.stream?.entries ?? [];
    let lo = 0;
    let hi = entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid]!.start <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const e = found >= 0 ? entries[found]! : null;
    return e && t < e.start + e.duration ? found : -1;
  };
  /** The element plays the current live start. */
  const playingLive = () => s.live !== null && s.loaded === s.live.url;
  /** Seconds into the current segment the element is at: a live stream's
   * clock starts at its cut. */
  const elementTime = () => (playingLive() ? s.live!.base + el.currentTime : el.currentTime);
  const liveTime = () => {
    if (!streaming()) return elementTime();
    const at = entryIndexOf(s.segments[s.index]?.id);
    return at >= 0 ? Math.max(0, el.currentTime - s.stream!.entries[at]!.start) : s.time;
  };
  const durationOf = (segment: Segment | undefined) =>
    segment
      ? (s.live?.segment === segment.id ? s.live.estimate : null) ??
        s.status[segment.id]?.duration_s ??
        s.pastDurations[segment.id] ??
        0
      : 0;
  /** Estimated seconds per character, from the book's measured average (server)
   * or 15 chars per second when the book has no measurement yet. */
  const secondsPerChar = () => {
    const est = s.book?.est_duration_s;
    const chars = s.book?.total_chars;
    return est && chars ? est / chars : 1 / 15;
  };
  /** A segment's real duration once its clip exists, else a character estimate. */
  const estimateOf = (segment: Segment | undefined) =>
    segment ? durationOf(segment) || (segment.char_end - segment.char_start) * secondsPerChar() : 0;
  const chapterTotal = () => s.segments.reduce((total, seg) => total + estimateOf(seg), 0);
  const elapsed = () => s.segments.slice(0, s.index).reduce((total, seg) => total + estimateOf(seg), 0) + s.time;

  /** The current segment plus the next BUFFER_AHEAD (or the rest of the chapter)
   * are all playable. Only consulted while prebuffering after a generation
   * stall. */
  const buffered = () =>
    s.segments
      .slice(s.index, s.index + 1 + BUFFER_AHEAD)
      .every((seg) => s.status[seg.id]?.status === "ready" && s.status[seg.id]?.url);

  /** Characters spoken so far: whole chapters before + segment start + share of the current segment. */
  const charPosition = () => {
    let chars = 0;
    for (let i = 0; i < s.chapterIdx; i += 1) chars += s.chapters[i]?.char_count ?? 0;
    const segment = s.segments[s.index];
    if (!segment) return chars;
    const duration = durationOf(segment);
    const share = duration > 0 ? Math.min(1, Math.max(0, s.time / duration)) : 0;
    return chars + segment.char_start + (segment.char_end - segment.char_start) * share;
  };

  /** Each chapter's own place (null: start over), seeded from the book's
   * per-chapter progress and kept current by every save, so jumping to a
   * chapter resumes where the listener left it. */
  const places = useRef(new Map<string, { segment_id: string; offset_s: number } | null>());

  /** Restart the 10 s save timer; every save calls this so saves never bunch up. */
  function armSaveTimer() {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (s.playing) saveTimer.current = window.setTimeout(() => void saveTick(), SAVE_MS);
  }

  function saveTick() {
    saveTimer.current = null;
    saveNow();
  }

  /** Upsert the current position. Silent: a failure shows nothing and the
   * next tick (or the next event) retries. */
  function saveNow() {
    const book = s.book;
    const chapter = s.chapters[s.chapterIdx];
    const segment = s.segments[s.index];
    if (!book || !chapter || !segment || s.resumeLoading) return;
    armSaveTimer();
    const done = s.chapterDone === chapter.id;
    places.current.set(chapter.id, done ? null : { segment_id: segment.id, offset_s: s.time });
    void saveProgress(book.id, {
      chapter_id: chapter.id,
      segment_id: segment.id,
      offset_s: s.time,
      device_label: deviceLabel(),
      ...(done ? { chapter_finished: true } : {}),
    }).then((res) => {
      if (!res) return;
      rememberPosition(book.id, res.progress);
      // Silent saves must still refresh what the pages read: the progress
      // cache (cover badge, progress line) updates at once, the book detail
      // and Continue row refetch on invalidation.
      queryClient.setQueryData(progressQueryKey(book.id), res.progress);
      void queryClient.invalidateQueries({ queryKey: ["book", book.id] });
      void queryClient.invalidateQueries({ queryKey: continueQueryKey });
    });
  }

  /** Jump to a saved position with the 3 s rewind, opening its chapter first when needed. */
  async function applyResume(position: Progress) {
    s.resumePrompt = null;
    s.resumeLoading = true;
    const ci = s.chapters.findIndex((c) => c.id === position.chapter_id);
    if (ci >= 0 && ci !== s.chapterIdx) await openChapter(ci, false);
    const si = s.segments.findIndex((seg) => seg.id === position.segment_id);
    seekSegment(si >= 0 ? si : 0, Math.max(0, position.offset_s - REWIND_S));
    s.resumeLoading = false;
    bump();
  }

  function fail(message: string) {
    s.preparing = false;
    s.error = message;
  }

  /** Start/continue the current segment. Returns while audio is already
   * playing: the only clip change mid-playback is handleEnded, which pumps
   * synchronously so iOS lets the element carry on from the lock screen. */
  function pump() {
    // A stale flag (the element was paused behind our back) must not block a resume.
    if (s.playing && el.paused && !el.ended && s.loaded) s.playing = false;
    if (!s.intent || s.playing) return;
    const item = currentItem();
    if (item?.status === "failed") {
      s.intent = false;
      s.playing = false;
      fail("Couldn't generate this part");
      return;
    }
    const live = s.live?.segment === s.segments[s.index]?.id ? s.live : null;
    let url: string;
    if (live && !(item?.status === "ready" && item.url && item.duration_s)) {
      // A live start plays until its segment's clip is stored.
      url = live.url;
      s.prebuffering = false;
      if (s.loaded !== url) {
        el.src = url;
        s.loaded = url;
      }
    } else {
      if (live && item?.duration_s) {
        // Resuming after the clip was stored: the same place in it (the clip
        // is the start of the segment, then exactly what the stream played).
        s.offset = timeForFraction(live.from, item.duration_s, item.marks) + Math.max(0, s.time - live.base);
        s.time = s.offset;
        s.live = null;
      }
      // A resume after a generation stall waits for a small buffer so it does not
      // start and then stall while the queued lookahead catches up. The poll keeps
      // topping up. (A voice change starts on the first ready segment instead.)
      if (s.prebuffering) {
        if (!buffered()) {
          s.preparing = true;
          publishSession();
          return;
        }
        s.prebuffering = false;
      }
      if (item?.status !== "ready" || !item.url) {
        s.preparing = true;
        publishSession();
        return;
      }
      url = loadClip(item.url);
    }
    startElement(url);
  }

  /** Point the element at the ready clip `url`, or at the book stream there
   * (Safari); returns what it now holds (`s.loaded`). */
  function loadClip(url: string): string {
    if (s.streamVoice && s.book && hlsPlayable()) return loadStream(s.book.id, s.streamVoice);
    if (s.loaded !== url) {
      el.src = clips.current.get(url) ?? url;
      s.loaded = url;
    }
    if (s.offset > 0) {
      el.currentTime = s.offset;
      s.offset = 0;
    }
    return url;
  }

  /** Play whatever the element now holds; `url` identifies it (pump's load). */
  function startElement(url: string) {
    el.playbackRate = s.rate; // a new src resets the rate to the default
    void el
      .play()
      .then(() => {
        if (s.loaded !== url) return; // a later pump already moved on to another clip
        if (!s.intent) {
          el.pause(); // paused while the promise was pending
          return;
        }
        s.playing = true;
        s.preparing = false;
        s.stalled = false;
        s.error = null;
        publishSession();
        prefetchChapter();
        fetchNextClip();
        bump();
      })
      .catch(() => {
        if (s.loaded !== url) return; // superseded by a newer src (AbortError), not a failure
        s.intent = false;
        s.playing = false;
        publishSession();
        bump();
      });
  }

  /** Point the element at the book stream positioned at the current segment +
   * `s.time`: reuse the stream when it lists the segment, else start a new one
   * there (a stream begins at its origin). Returns the stream URL. */
  function loadStream(bookId: string, voice: string): string {
    const segment = s.segments[s.index]!;
    let at = s.stream && s.stream.voice === voice ? entryIndexOf(segment.id) : -1;
    if (at < 0 && !(s.stream?.origin === segment.id && s.stream.voice === voice)) {
      const url = streamPlaylistUrl(bookId, voice, segment.id);
      s.stream = { origin: segment.id, voice, url, entries: [], complete: false, pendingSeek: null, fetchedAt: 0 };
      void refreshTimeline(true);
    }
    const stream = s.stream!;
    if (s.loaded !== stream.url) {
      el.src = stream.url;
      s.loaded = stream.url;
    }
    at = entryIndexOf(segment.id);
    seekStream((at >= 0 ? stream.entries[at]!.start : 0) + s.time);
    s.offset = 0;
    return stream.url;
  }

  /** Move the stream to `target` seconds; a no-op when it is already there
   * (a resume must not re-buffer). Re-applied once metadata has loaded. */
  function seekStream(target: number) {
    if (!s.stream) return;
    if (Math.abs(el.currentTime - target) < 0.5) return;
    el.currentTime = target;
    if (el.readyState < 1) s.stream.pendingSeek = target;
  }

  /** Fetch the stream's timeline (throttled unless `force`); the playlist only
   * grows, so a newer answer always replaces the old one. */
  async function refreshTimeline(force: boolean) {
    const stream = s.stream;
    const bookId = s.book?.id;
    if (!stream || !bookId || stream.complete) return;
    const now = Date.now();
    if (!force && now - stream.fetchedAt < TIMELINE_REFRESH_MS) return;
    stream.fetchedAt = now;
    try {
      const timeline = await fetchStreamTimeline(bookId, stream.voice, stream.origin);
      if (s.stream !== stream) return; // superseded by a seek or voice change
      stream.entries = timeline.entries;
      stream.complete = timeline.complete;
      bump();
    } catch {
      stream.fetchedAt = 0; // silent; the next timeupdate tries again
    }
  }

  /** timeupdate while streaming: map stream time to chapter/segment/offset,
   * stop at a chapter end when the listener asked to, and keep the timeline
   * ahead of playback. Runs while audio plays, even with the screen locked. */
  function onStreamTime() {
    const stream = s.stream!;
    const t = el.currentTime;
    const at = entryAt(t);
    if (!stream.complete && (at < 0 || at >= stream.entries.length - 2)) void refreshTimeline(false);
    if (at < 0) return;
    const entry = stream.entries[at]!;
    const next = stream.entries[at + 1];
    const chapterEnds = next ? next.chapter_id !== entry.chapter_id : stream.complete;
    const stopHere = s.sleep === "chapter" || !settingsRef.current.auto_next;
    if (
      chapterEnds &&
      stopHere &&
      s.chapterStop !== entry.chapter_id &&
      t >= entry.start + entry.duration - CHAPTER_STOP_S
    ) {
      s.chapterStop = entry.chapter_id;
      s.chapterDone = entry.chapter_id;
      adoptStreamEntry(entry, t - entry.start);
      pause();
      return;
    }
    adoptStreamEntry(entry, t - entry.start);
  }

  /** The stream entry last adopted, and whether its save is still owed (a new
   * chapter's segments may arrive a moment after the stream enters it). */
  const streamAt = useRef<{ segment: string | null; unsaved: boolean }>({ segment: null, unsaved: false });
  function adoptStreamEntry(entry: StreamEntry, offset: number) {
    if (entry.chapter_id !== s.chapters[s.chapterIdx]?.id) streamIntoChapter(entry.chapter_id);
    if (streamAt.current.segment !== entry.segment_id) {
      streamAt.current = { segment: entry.segment_id, unsaved: true };
    }
    const idx = s.segments.findIndex((seg) => seg.id === entry.segment_id);
    if (idx >= 0) s.index = idx;
    s.time = offset;
    if (idx >= 0 && streamAt.current.unsaved) {
      streamAt.current.unsaved = false;
      saveNow(); // segment change
    }
    // Have the next chapter's segments cached before the stream crosses into it.
    const upcoming = s.chapters[s.chapterIdx + 1];
    if (s.book && upcoming && s.index >= s.segments.length - 2) {
      const bookId = s.book.id;
      void queryClient.prefetchQuery({
        queryKey: ["segments", bookId, upcoming.id],
        queryFn: () => fetchSegments(bookId, upcoming.id),
      });
    }
  }

  /** The stream crossed into another chapter on its own: follow it. */
  function streamIntoChapter(chapterId: string) {
    const book = s.book;
    const ci = s.chapters.findIndex((c) => c.id === chapterId);
    if (!book || ci < 0) return;
    // Playback carried the stream past the old chapter's end: it was heard.
    if (ci === s.chapterIdx + 1) s.chapterDone = s.chapters[s.chapterIdx]?.id ?? null;
    saveNow(); // the old chapter's last position
    s.chapterDone = null;
    s.chapterIdx = ci;
    s.chapterStop = null;
    s.index = 0;
    const key = ["segments", book.id, chapterId];
    const cached = queryClient.getQueryData<Segment[]>(key);
    s.segments = cached ?? [];
    if (!cached) {
      void queryClient
        .fetchQuery({ queryKey: key, queryFn: () => fetchSegments(book.id, chapterId) })
        .then((segments) => {
          if (s.chapters[s.chapterIdx]?.id !== chapterId) return;
          s.segments = segments;
          bump(); // the next timeupdate places the index
        })
        .catch(() => undefined);
    }
    void topUp(); // statuses (durations) for the new chapter
  }

  /** Stop the element and forget the playing flag: the only way back to audio
   * is pump(). */
  function silence() {
    s.playing = false;
    s.stalled = false;
    el.pause();
  }

  /** Fetch the next ready clip into memory so the boundary needs no network:
   * iOS lets the `ended` handler start the next clip on the same element, but
   * a slow load there is an audible gap. Only the next clip is kept. */
  function fetchNextClip() {
    if (streaming()) return; // the stream carries the boundary itself
    const next = s.status[s.segments[s.index + 1]?.id ?? ""];
    const url = next?.status === "ready" ? next.url : null;
    for (const [key, objectUrl] of clips.current) {
      if (key === url || key === s.loaded) continue;
      clips.current.delete(key);
      URL.revokeObjectURL(objectUrl);
    }
    if (!url || clips.current.has(url) || fetchingClip.current === url) return;
    if (typeof URL.createObjectURL !== "function") return;
    fetchingClip.current = url;
    void fetchAudioClip(url)
      .then((blob) => {
        if (fetchingClip.current === url) clips.current.set(url, URL.createObjectURL(blob));
      })
      .catch(() => {
        /* silent: the element streams the clip from the network instead */
      })
      .finally(() => {
        if (fetchingClip.current === url) fetchingClip.current = null;
      });
  }

  /** prepare for the current segment + lookahead, merge statuses; the trailing
   * pump can only start audio when nothing is playing, never mid-playback.
   * `retryFailed` re-queues failed rows in the window — only from an explicit
   * user action (play, seek, Retry); the poll and every automatic top-up omit it. */
  const toppingUp = useRef(false);
  async function topUp(retryFailed = false) {
    const segment = s.segments[s.index];
    if (!s.book || !segment) return;
    // Polling and SSE frames can ask for the same window at the same time;
    // one in-flight prepare is enough and dozens would exhaust the browser.
    if (toppingUp.current) return;
    toppingUp.current = true;
    const voice = effectiveVoice(s.book);
    let stale = false;
    try {
      const res = await prepareAudio(s.book.id, segment.id, TTS_LOOKAHEAD, voice, retryFailed);
      // The voice changed while this was in flight: its statuses and stream
      // are the old voice's. Ask again instead of playing them.
      stale = !s.book || effectiveVoice(s.book) !== voice;
      if (!stale) {
        s.status = { ...s.status, ...Object.fromEntries(res.items.map((item) => [item.segment_id, item])) };
        s.streamVoice = res.stream && res.voice ? res.voice : null;
        applyVoiceSwap();
        if (s.playing) fetchNextClip();
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not reach the server.");
    } finally {
      toppingUp.current = false;
    }
    if (stale) {
      void topUp(retryFailed);
      return;
    }
    pump();
    bump();
  }

  /** Once the new voice's clip for the segment exists, place the restart at
   * the same sentence in it. */
  function applyVoiceSwap() {
    const swap = s.voiceSwap;
    if (!swap) return;
    if (s.segments[s.index]?.id !== swap.segment) {
      s.voiceSwap = null;
      return;
    }
    const item = s.status[swap.segment];
    if (item?.status !== "ready" || !item.duration_s) return;
    s.offset = timeForFraction(swap.fraction, item.duration_s, item.marks);
    s.time = s.offset;
    s.voiceSwap = null;
  }

  /** Book narrator wins over the per-language preference (server: book →
   * listener preference → server default). Pins are keyed by base language. */
  function effectiveVoice(book: Book): string | undefined {
    return book.narrator_voice ?? settingsRef.current.voices[baseLanguage(book.language)] ?? undefined;
  }

  /** Once audio actually starts, queue the rest of the chapter in the
   * background: the lookahead only covers the next few segments, so a listener
   * who keeps playing would otherwise wait on the queue at every boundary.
   * The backend slices from the current segment (and keeps it PRIORITY_NOW),
   * so `count` = the chapter's segment length covers the chapter. Statuses are
   * deliberately ignored — the normal top-up still merges the lookahead. */
  const prefetchedChapter = useRef<string | null>(null);
  function prefetchChapter() {
    const book = s.book;
    const chapter = s.chapters[s.chapterIdx];
    const segment = s.segments[s.index];
    if (!book || !chapter || !segment || prefetchedChapter.current === chapter.id) return;
    prefetchedChapter.current = chapter.id;
    void prepareAudio(book.id, segment.id, s.segments.length, effectiveVoice(book)).catch(
      () => {
        prefetchedChapter.current = null; // silent; retried when the next segment starts
      },
    );
  }

  /** Open a chapter at its start, or (`resume`) where this listener left it. */
  async function openChapter(idx: number, autoplay: boolean, resume = false) {
    const book = s.book;
    const chapter = s.chapters[idx];
    if (!book || !chapter) return;
    if (!s.resumeLoading && s.segments.length > 0) saveNow(); // chapter change: save the old position
    s.chapterDone = null;
    s.voiceSwap = null;
    s.live = null;
    liveRequest.current += 1;
    silence(); // never let the old chapter's element keep running under the new one
    s.chapterIdx = idx;
    s.segments = [];
    s.index = 0;
    s.status = {};
    s.pastDurations = {};
    s.time = 0;
    s.offset = 0;
    s.error = null;
    s.prebuffering = false;
    s.preparing = autoplay;
    publishSession();
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
    const place = resume ? places.current.get(chapter.id) : null;
    const at = place ? s.segments.findIndex((seg) => seg.id === place.segment_id) : -1;
    if (place && at >= 0) {
      s.index = at;
      s.offset = Math.max(0, place.offset_s - REWIND_S);
      s.time = s.offset;
    }
    if (autoplay) s.intent = true;
    await topUp();
  }

  /** Must start the next clip synchronously: with the screen locked, iOS only
   * lets audio continue if the element is told to play from this handler. */
  function handleEnded() {
    if (streaming()) {
      // A growing playlist never ends; the stream ends with the book.
      if (!s.stream!.complete) {
        void refreshTimeline(true);
        return;
      }
      s.playing = false;
      s.intent = false;
      s.chapterDone = s.chapters[s.chapterIdx]?.id ?? null;
      markBookFinished();
      publishSession();
      bump();
      return;
    }
    if (playingLive()) s.live = null; // the rest of the segment was heard
    s.time = 0;
    s.playing = false;
    if (s.index + 1 < s.segments.length) {
      s.index += 1;
      s.offset = 0;
      saveNow(); // segment change
      if (currentItem()?.status === "ready") pump();
      else {
        // Ran into generation: stop the lock-screen clock now, and resume only
        // once a few segments are ready rather than stall again right after.
        s.preparing = true;
        s.prebuffering = true;
        void topUp();
      }
    } else {
      if (s.sleep === "chapter") s.intent = false;
      s.chapterDone = s.chapters[s.chapterIdx]?.id ?? null; // heard to the end
      saveNow();
      void advanceChapter();
    }
    publishSession(); // synchronously: a locked screen may not render again soon
    bump();
  }

  async function advanceChapter() {
    if (!s.intent || !settingsRef.current.auto_next || s.chapterIdx + 1 >= s.chapters.length) {
      s.intent = false;
      s.playing = false;
      s.preparing = false;
      if (s.book && s.chapterIdx + 1 >= s.chapters.length) markBookFinished();
      publishSession();
      bump();
      return;
    }
    await openChapter(s.chapterIdx + 1, true);
  }

  /** The last segment of the last chapter ended: save once, then mark finished. */
  function markBookFinished() {
    const bookId = s.book!.id;
    s.finished = true;
    saveNow();
    if (s.finishedMarked) return;
    s.finishedMarked = true;
    void markFinished(bookId, true)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["book", bookId] });
        queryClient.invalidateQueries({ queryKey: progressQueryKey(bookId) });
        queryClient.invalidateQueries({ queryKey: continueQueryKey });
      })
      .catch(() => {
        s.finishedMarked = false; // silent; retried the next time the book ends
      });
  }

  async function load(bookId: string, chapterId?: string) {
    if (s.book?.id === bookId && s.segments.length > 0 && (!chapterId || s.chapters[s.chapterIdx]?.id === chapterId)) return;
    s.prebuffering = false; // a fresh session always starts normally
    forgetClosed();
    const switching = s.book !== null && s.book.id !== bookId;
    try {
      const detail = await queryClient.fetchQuery({ queryKey: ["book", bookId], queryFn: () => fetchBookDetail(bookId) });
      if (switching) {
        // Never carry the previous book's position into the new one.
        silence();
        dropStream();
        s.live = null;
        s.streamVoice = null;
        s.chapterIdx = 0;
        s.segments = [];
        s.index = 0;
        s.status = {};
        s.pastDurations = {};
        s.time = 0;
        s.offset = 0;
      }
      s.book = detail.book;
      // Per-book speed memory: the speed stored for this book wins; a book
      // never played here starts at the Settings default, both snapped to
      // the config grid.
      s.rate = snapSpeed(readBookSpeed(bookId) ?? settingsRef.current.speed, speedOptionsRef.current);
      el.playbackRate = s.rate;
      el.defaultPlaybackRate = s.rate;
      // Excluded chapters are returned for the book-settings UI but must never
      // be opened by the player (their segments endpoint 404s by design).
      // All chapter indices below come from this included list — indexing the
      // unfiltered detail.chapters made a saved chapter land N included
      // chapters too deep once N chapters were excluded (the 16 % bug).
      const included = detail.chapters.filter((chapter) => !chapter.excluded);
      s.chapters = included;
      places.current = new Map(
        included.map((chapter) => {
          const place = chapter.progress?.segment_id
            ? { segment_id: chapter.progress.segment_id, offset_s: chapter.progress.offset_s }
            : null;
          return [chapter.id, place];
        }),
      );
      s.finished = Boolean(detail.progress?.finished_at);
      s.finishedMarked = s.finished;
      s.resumePrompt = null;
      const saved = detail.progress;
      // Resume only when the saved chapter is included in *this* book;
      // otherwise start fresh at the first included chapter, segment 0.
      const ci = saved ? included.findIndex((c) => c.id === saved.chapter_id) : -1;
      const canResume = ci >= 0;
      s.lastDevice =
        canResume && saved && saved.device_label !== deviceLabel()
          ? { label: saved.device_label, at: saved.updated_at }
          : null;
      const idx = canResume ? ci : chapterId ? Math.max(0, included.findIndex((c) => c.id === chapterId)) : 0;
      s.resumeLoading = canResume;
      await openChapter(idx, false); // open the saved chapter first
      s.resumeLoading = false;
      if (canResume && saved) {
        const local = readPosition(bookId);
        if (local && saved.device_label !== deviceLabel() && secondsAhead(saved, local, detail.book) > AHEAD_PROMPT_S) {
          const segment = s.segments.find((seg) => seg.id === saved.segment_id);
          s.resumePrompt = {
            device: saved.device_label,
            chapter: included[ci]!.title,
            time: formatTime(saved.offset_s + (segment ? segment.char_start * secondsPerChar() : 0)),
            onContinue: () => void applyResume(saved),
            onStartHere: () => void applyResume(local),
          };
        } else {
          await applyResume(saved);
        }
        bump();
      }
    } catch (error) {
      s.resumeLoading = false;
      s.error = error instanceof Error ? error.message : "Could not reach the server.";
      bump();
    }
  }

  /** Fire a silent clip through the element so iOS unlocks it for everything
   * that follows (including `ended` handlers on a locked screen). Must run
   * synchronously inside the tap, before any await; real audio assigned
   * afterwards wins. */
  const unlocked = useRef(false);
  function unlockAudio() {
    if (unlocked.current) return;
    unlocked.current = true;
    const previous = el.getAttribute("src") ?? "";
    const previousLoaded = s.loaded;
    el.src = SILENT_SRC;
    s.loaded = null; // the next pump must load its clip, not play the silence
    const restore = () => {
      if (el.getAttribute("src") !== SILENT_SRC) return; // real audio took over
      el.src = previous;
      s.loaded = previousLoaded;
    };
    void el.play().then(() => {
      if (el.getAttribute("src") === SILENT_SRC) el.pause();
      restore();
    }, restore);
  }

  async function play() {
    unlockAudio(); // before any await: iOS only allows play() from the gesture
    s.intent = true;
    s.resumePrompt = null; // playing from here is a choice of its own
    s.lastDevice = null; // from now on this device owns the position
    if (!s.book) {
      const id = new URLSearchParams(location.search).get("book");
      if (!id) return;
      await load(id);
    }
    const item = currentItem();
    if (item?.status === "ready") {
      pump();
    } else {
      // Resuming onto a segment that is still generating must ask immediately;
      // waiting for the poll made pause/resume look stuck. A failed one is
      // re-queued too: nothing automatic will ever retry it.
      s.preparing = true;
      bump();
      await topUp(true);
    }
    bump();
  }

  function pause() {
    s.intent = false;
    s.preparing = false;
    s.prebuffering = false;
    silence(); // both elements: the preloaded one may have been left running
    saveNow(); // spec: save on pause
    publishSession();
    bump();
  }

  function toggle() {
    if (s.intent) pause();
    else void play();
  }

  function stop() {
    const bookId = s.book?.id;
    if (bookId) rememberClosed(bookId); // a reload must not reopen it
    silence();
    s.intent = false;
    s.preparing = false;
    s.prebuffering = false;
    saveNow(); // never lose the position we stop at
    for (const objectUrl of clips.current.values()) URL.revokeObjectURL(objectUrl);
    clips.current.clear();
    dropStream();
    s.live = null;
    s.streamVoice = null;
    s.book = null;
    s.chapters = [];
    s.chapterIdx = 0;
    s.segments = [];
    s.index = 0;
    s.status = {};
    s.pastDurations = {};
    s.time = 0;
    s.error = null;
    s.resumePrompt = null;
    s.lastDevice = null;
    if (location.pathname === "/player") {
      // "Stop and close" returns to the page the listener opened the player from;
      // a direct load has no entry to return to, so fall back to the book.
      navigate(lastPath.current ?? (bookId ? `/books/${bookId}` : "/library"), { replace: true });
    } else if (location.search) {
      navigate(location.pathname, { replace: true }); // /player must not reload the book
    }
    bump();
  }

  /** A narrator changed: drop the prepared audio for the current position and
   * ask for it again with the new voice, keeping the exact offset and whether
   * the listener was playing (paused players reload paused). A playing player
   * restarts on the first ready segment; the rest keeps buffering behind it. */
  function reloadVoice(bookId?: string) {
    if (!s.book || (bookId && s.book.id !== bookId)) return;
    const wasPlaying = s.intent || s.playing; // read before silence() clears the flag
    const cached = queryClient.getQueryData<BookDetailResponse>(["book", s.book.id])?.book;
    if (cached) s.book = cached;
    // Read the live element while playing so the reload resumes exactly where
    // the listener was, not at the last (throttled) timeupdate.
    const offset = s.playing ? liveTime() : s.time;
    const segment = s.segments[s.index];
    const old = segment ? s.status[segment.id] : undefined;
    // A switch during a live start: where its stream had got to.
    const fromLive = segment && s.live?.segment === segment.id ? heldShare() : null;
    // The new voice's clip has another length and pace: restart at the same
    // sentence (placed once its clip exists), not at the old clip's second.
    s.voiceSwap =
      segment && fromLive !== null
        ? { segment: segment.id, fraction: fromLive }
        : segment && old?.duration_s
          ? { segment: segment.id, fraction: sentenceStartFraction(offset, old.duration_s, old.marks) }
          : null;
    s.live = null;
    s.offset = offset;
    s.time = offset;
    silence();
    dropStream(); // the new voice is a different stream
    s.loaded = null; // the element holds the old voice: the next start loads the new one
    for (const [id, item] of Object.entries(s.status)) {
      if (item.duration_s) s.pastDurations[id] = item.duration_s;
    }
    s.status = {};
    prefetchedChapter.current = null; // the new voice has to be synthesized for the whole chapter
    // Start like a fresh play: the current segment alone is enough, and the
    // lookahead and the rest of the chapter keep synthesizing behind it (a
    // playing listener's poll and prefetch, an iOS stream's growing playlist).
    // Waiting for BUFFER_AHEAD whole clips in the new voice left the player
    // silent in "Preparing audio…" for as long as those took.
    s.prebuffering = false;
    s.preparing = wasPlaying;
    // A playing listener hears the new voice at once: the server streams the
    // segment from their sentence while it makes it. Paused, prepare as usual.
    if (wasPlaying && segment) void startLiveVoice(segment);
    else void topUp();
    bump();
  }

  /** Each live request, voice change or move; a stale answer is dropped. */
  const liveRequest = useRef(0);
  async function startLiveVoice(segment: Segment) {
    const book = s.book;
    if (!book) return;
    const request = ++liveRequest.current;
    const estimate = estimateOf(segment) || 1;
    const at = s.voiceSwap?.segment === segment.id ? s.voiceSwap.fraction : Math.min(1, s.time / estimate);
    // A failed request leaves it to the queue, as before.
    const answer = await startLive(book.id, segment.id, at, effectiveVoice(book)).catch(() => null);
    const current =
      request === liveRequest.current && s.book?.id === book.id && s.segments[s.index]?.id === segment.id;
    if (current && s.intent && !s.playing && answer?.status === "streaming" && answer.url) {
      const from = answer.from ?? 0;
      s.live = { segment: segment.id, url: answer.url, from, estimate, base: from * estimate };
      s.voiceSwap = null;
      s.time = s.live.base;
      s.offset = 0;
      pump();
    }
    if (current) void topUp(); // the lookahead, and the clip of a segment already made
    bump();
  }

  /** The share of the current segment's text being spoken while it has no
   * clip in the new voice (see `swapShare`), else null. */
  function heldShare(): number | null {
    const segment = s.segments[s.index];
    if (!segment) return null;
    if (s.live?.segment === segment.id) {
      return Math.min(1, Math.max(s.live.from, s.time / s.live.estimate));
    }
    return s.voiceSwap?.segment === segment.id ? s.voiceSwap.fraction : null;
  }

  /** Seek to a segment + offset within it; prepares first when unknown. */
  function seekSegment(index: number, offsetSeconds: number) {
    if (index < 0 || index >= s.segments.length) return;
    s.chapterDone = null; // a move inside the chapter: it is being listened to again
    s.voiceSwap = null; // an explicit place wins over the voice-change restart
    s.live = null; // a seek inside a live stream waits for the stored clip
    liveRequest.current += 1;
    if (streaming()) {
      const at = entryIndexOf(s.segments[index]!.id);
      if (at >= 0) {
        // Inside the listed run: move the stream, no reload.
        s.index = index;
        s.time = Math.max(0, offsetSeconds);
        s.offset = 0;
        s.chapterStop = null;
        seekStream(s.stream!.entries[at]!.start + s.time);
        saveNow();
        publishSession();
        bump();
        return;
      }
      dropStream(); // outside it: the next pump starts a stream there
    }
    s.index = index;
    s.offset = Math.max(0, offsetSeconds);
    s.time = s.offset;
    s.prebuffering = false; // a deliberate jump plays now, no buffer wait
    silence(); // stop the running element (and the preloaded one) before restarting
    // Prepare the target first so the UI shows "Preparing audio…" instead of silence.
    if (currentItem()?.status === "ready") pump();
    else void topUp(true); // a jump to a failed segment re-queues it
    saveNow(); // segment change from scrubbing/jumping (quiet during resume)
    bump();
  }

  function seekChapter(seconds: number) {
    const total = chapterTotal();
    if (total <= 0) return;
    const target = Math.min(Math.max(0, seconds), total);
    let acc = 0;
    for (let i = 0; i < s.segments.length; i += 1) {
      const d = estimateOf(s.segments[i]);
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

  function skipBack() {
    skip(-settingsRef.current.skip_back);
  }

  function skipForward() {
    skip(settingsRef.current.skip_forward);
  }

  async function stepChapter(delta: number) {
    const idx = Math.min(Math.max(0, s.chapterIdx + delta), s.chapters.length - 1);
    // A chosen chapter resumes where it was left (a finished one starts over).
    if (idx !== s.chapterIdx) await openChapter(idx, s.intent, true);
  }

  function goToChapter(chapterId: string): Promise<void> {
    const idx = s.chapters.findIndex((c) => c.id === chapterId);
    if (idx >= 0 && idx !== s.chapterIdx) return stepChapter(idx - s.chapterIdx);
    return Promise.resolve();
  }

  function setRate(rate: number) {
    s.rate = snapSpeed(rate, speedOptionsRef.current); // clamp + snap to the config grid
    el.playbackRate = s.rate;
    el.defaultPlaybackRate = s.rate;
    if (s.book) writeBookSpeed(s.book.id, s.rate); // remembered per book
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
    void topUp(true); // the poll alone is a no-op for failed rows
  }

  /** The live stream broke: wait for the stored clip and restart there. */
  function liveFailed() {
    const segment = s.segments[s.index];
    const share = heldShare();
    s.live = null;
    s.loaded = null;
    s.playing = false;
    s.voiceSwap = segment && share !== null ? { segment: segment.id, fraction: share } : null;
    s.preparing = s.intent;
    void topUp();
    bump();
  }

  /** Mirror the player into the lock screen. Called synchronously from media
   * events as well as after renders: iOS extrapolates the clock from the last
   * published position while playbackState is "playing", and a locked screen
   * may not render React again for a long time. Metadata is only replaced when
   * it changes — every new MediaMetadata makes iOS reload the artwork. */
  const sessionKeys = useRef({ metadata: "", position: "" });
  function publishSession() {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    const book = s.book;
    const title = s.chapters[s.chapterIdx]?.title ?? book?.title ?? "";
    const metadataKey = book ? `${book.id}|${title}|${book.cover_url ?? ""}|${book.authors.join(", ")}` : "";
    if (metadataKey !== sessionKeys.current.metadata && typeof MediaMetadata !== "undefined") {
      sessionKeys.current.metadata = metadataKey;
      ms.metadata = book
        ? new MediaMetadata({
            title,
            artist: book.authors.join(", "),
            album: book.title,
            artwork: book.cover_url ? [{ src: book.cover_url }] : [],
          })
        : null;
    }
    // From the listener's intent, not s.playing: that flag is briefly false at
    // every clip boundary, and publishing "paused" there flashed the lock
    // screen's play button. Waiting on generation or buffering stops the clock.
    const flowing = s.intent && !s.preparing && !s.stalled && !s.error;
    const state: MediaSessionPlaybackState = flowing ? "playing" : "paused";
    if (ms.playbackState !== state) ms.playbackState = state;
    // A complete stream (EXT-X-ENDLIST) is one real track: iOS shows its own
    // position and state, which (unlike a published position) stop when the
    // audio stops. A stream still growing (EVENT, no ENDLIST) has an infinite
    // duration and iOS draws it as live — no bar, no times — so it gets the
    // chapter position below, like the clip player.
    if (streaming() && Number.isFinite(el.duration) && el.duration > 0) {
      if (sessionKeys.current.position !== "stream" && ms.setPositionState) {
        sessionKeys.current.position = "stream";
        try {
          ms.setPositionState();
        } catch {
          /* nothing published to clear */
        }
      }
      return;
    }
    // Without this iOS shows the element's own ~40 s clip as the whole track.
    const duration = chapterTotal();
    const position = Math.min(elapsed(), duration);
    // Once per playback second, and at once on a seek or a state change.
    const key = `${duration}|${Math.floor(position)}|${s.rate}|${state}`;
    if (duration > 0 && ms.setPositionState && sessionKeys.current.position !== key) {
      sessionKeys.current.position = key;
      try {
        ms.setPositionState({ duration, position, playbackRate: s.rate });
      } catch {
        /* iOS rejects an out-of-range position */
      }
    }
  }

  // Latest closures for the stable effects below (state lives in `s`, not closures).
  const fns = useRef({ topUp, play, pause, skip, skipBack, skipForward, stepChapter, handleEnded, saveNow, publishSession, onStreamTime, elementTime, liveFailed });
  fns.current = { topUp, play, pause, skip, skipBack, skipForward, stepChapter, handleEnded, saveNow, publishSession, onStreamTime, elementTime, liveFailed };

  // Sync the saved default speed into the player. A book with its own stored
  // speed keeps it: the default only drives books played here for the first
  // time (and the idle player before anything is loaded).
  useEffect(() => {
    if (s.book && readBookSpeed(s.book.id) !== null) return;
    const rate = snapSpeed(settings.speed, speedOptionsRef.current);
    if (s.rate === rate) return;
    s.rate = rate;
    el.playbackRate = rate;
    el.defaultPlaybackRate = rate;
    bump();
  }, [settings.speed, el, s]);

  useEffect(() => {
    const onEnded = () => {
      if (s.loaded) fns.current.handleEnded(); // not the unlock clip
    };
    const onTime = () => {
      if (!s.loaded) return;
      if (s.stream && s.loaded === s.stream.url) fns.current.onStreamTime();
      else s.time = fns.current.elementTime();
      fns.current.publishSession();
      bump();
    };
    const onMetadata = () => {
      const stream = s.stream;
      if (!stream || s.loaded !== stream.url || stream.pendingSeek === null) return;
      el.currentTime = stream.pendingSeek;
      stream.pendingSeek = null;
    };
    // iOS pauses the element itself on interruptions (calls, Siri, unplugged
    // headphones, background suspension). Our own pauses clear s.playing first,
    // and the pause that precedes `ended` has `ended` set, so anything else is
    // external: adopt it, or the app and lock screen both believe it still plays.
    const onPause = () => {
      if (!s.playing || el.ended) return;
      s.time = fns.current.elementTime();
      s.intent = false;
      s.preparing = false;
      s.prebuffering = false;
      s.playing = false;
      s.stalled = false;
      fns.current.saveNow();
      fns.current.publishSession();
      bump();
    };
    // Mid-clip buffering only: the load at a clip boundary is expected and short.
    const onWaiting = () => {
      if (!s.playing || el.currentTime === 0) return;
      s.stalled = true;
      fns.current.publishSession();
    };
    // A live stream that breaks (the server restarted, the network dropped)
    // falls back to waiting for the stored clip at the same place.
    const onError = () => {
      if (s.live && s.loaded === s.live.url) fns.current.liveFailed();
    };
    const onPlaying = () => {
      if (!s.stalled) return;
      s.stalled = false;
      fns.current.publishSession();
    };
    const listeners: [string, (event: Event) => void][] = [
      ["ended", onEnded],
      ["timeupdate", onTime],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["playing", onPlaying],
      ["loadedmetadata", onMetadata],
      ["error", onError],
    ];
    for (const [name, fn] of listeners) el.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of listeners) el.removeEventListener(name, fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- el and the s ref are stable; handlers read live state through them
  }, [el]);

  // The element is detached from the DOM, so unmounting (e.g. a lost session
  // sending the app to /login) would leave it playing: stop it.
  useEffect(() => () => el.pause(), [el]);

  // Poll prepare while waiting on generation, and keep a slow beat while
  // playing so a status the in-flight guard dropped cannot leave the next
  // segment stale ("queued") at a boundary. SSE `audio` frames accelerate it.
  useEffect(() => {
    if (!s.intent || (!s.playing && !s.preparing)) return;
    const timer = window.setInterval(
      () => void fns.current.topUp(),
      s.playing ? PLAYING_POLL_MS : POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [s.intent, s.playing, s.preparing]);

  // Background tabs throttle timers; catching up on return avoids a dead
  // "Preparing audio…" after the user comes back to the tab.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "visible" && s.intent && s.preparing) {
        void fns.current.topUp();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- s is a stable ref
  }, []);

  // The 10 s save timer runs only while playing; event saves re-arm it.
  useEffect(() => {
    armSaveTimer();
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armSaveTimer reads live state through the s ref
  }, [s.playing]);

  // Spec "Progress model": save when the tab hides or the page goes away.
  // fetch keepalive (not sendBeacon, which cannot set the CSRF header).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") fns.current.saveNow();
    };
    const onPagehide = () => fns.current.saveNow();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPagehide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPagehide);
    };
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    // ponytail: second EventSource (useEvents owns the first); consolidate if connection count ever matters.
    const source = new EventSource("/api/v1/events");
    source.addEventListener("audio", (event) => {
      if (!s.book) return;
      try {
        const frame = JSON.parse((event as MessageEvent<string>).data) as {
          book_id?: string | null;
          segment_id?: string;
          done?: number;
          total?: number;
        };
        // Ignore other books and segments outside the current window.
        if (frame.book_id && frame.book_id !== s.book.id) return;
        if (frame.segment_id && !s.status[frame.segment_id]) return;
        // Sentence progress: redraw "4 of 11 sentences"; nothing to re-prepare.
        if (frame.segment_id && typeof frame.done === "number" && typeof frame.total === "number") {
          s.progress[frame.segment_id] = { done: frame.done, total: frame.total };
          bump();
          return;
        }
      } catch {
        return;
      }
      void fns.current.topUp();
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
      ["seekbackward", () => fns.current.skipBack()],
      ["seekforward", () => fns.current.skipForward()],
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

  // A per-language preference change reloads the loaded book only when the
  // book has no narrator of its own (the book narrator always wins).
  const prefState = useRef<{ bookId: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!s.book) {
      prefState.current = null;
      return;
    }
    const value = s.book.narrator_voice
      ? null
      : settings.voices[baseLanguage(s.book.language)] ?? null;
    if (!prefState.current || prefState.current.bookId !== s.book.id) {
      prefState.current = { bookId: s.book.id, value };
      return;
    }
    if (prefState.current.value === value) return;
    prefState.current.value = value;
    reloadVoice(s.book.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- s.book is a ref; values compared above
  }, [settings.voices, s.book]);

  // Seeks, chapter changes, rate changes and the like all re-render; publish
  // after each (cheap: publishSession drops repeats).
  useEffect(() => publishSession());

  const syncBookId = s.book?.id;
  const syncChapterId = s.chapters[s.chapterIdx]?.id;
  useEffect(() => {
    if (location.pathname !== "/player") lastPath.current = location.pathname + location.search;
  }, [location]);
  useEffect(() => {
    if (location.pathname !== "/player" || !syncBookId) return;
    const search = new URLSearchParams({ book: syncBookId });
    if (syncChapterId) search.set("chapter", syncChapterId);
    if (location.search !== `?${search}`) navigate(`/player?${search}`, { replace: true });
  }, [location.pathname, location.search, syncBookId, syncChapterId, navigate]);

  const totalChars = s.book?.total_chars ?? 0;
  const progressPercent = s.finished ? 100 : totalChars > 0 ? Math.min(100, (charPosition() / totalChars) * 100) : 0;

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
    preparingProgress: (s.preparing && s.progress[s.segments[s.index]?.id ?? ""]) || null,
    error: s.error,
    time: s.time,
    swapShare: heldShare(),
    rate: s.rate,
    sleep: s.sleep,
    settings,
    finished: s.finished,
    progressPercent,
    resumePrompt: s.resumePrompt,
    lastDevice: s.lastDevice,
    chapterElapsed: elapsed(),
    chapterTotal: chapterTotal(),
    chapterTotalApprox: s.segments.some((seg) => durationOf(seg) <= 0),
    element: el,
    liveTime,
    load,
    reloadVoice,
    play,
    pause,
    stop,
    toggle,
    seekChapter,
    seekSegment,
    skip,
    skipBack,
    skipForward,
    stepChapter,
    goToChapter,
    setRate,
    setSleep,
    retry,
  };

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}
