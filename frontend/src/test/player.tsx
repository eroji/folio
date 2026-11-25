/** Shared fixtures for the player tests: fake book/chapter/segment endpoints
 * plus HTMLMediaElement play/pause stubs (jsdom has no audio backend). */
import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Book, Chapter, Progress } from "../api/types";
import type { AudioStatus, LiveStart, Segment } from "../api/audio";
import { DEFAULT_SETTINGS, DEFAULT_SPEED_OPTIONS, type ListeningSettings, type SpeedOptions } from "../api/settings";
import { PlayerProvider, SILENT_SRC, type PlayerContextValue } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";

export const BOOK_ID = "11111111-1111-1111-1111-111111111111";
export const CH1 = "c1111111-1111-1111-1111-111111111111";
export const CH2 = "c2222222-2222-2222-2222-222222222222";
/** A second book so tests can load one book after the other. */
export const BOOK2_ID = "22222222-2222-2222-2222-222222222222";
export const CH3 = "c3333333-3333-3333-3333-333333333333";

export function makeBook(): Book {
  return {
    id: BOOK_ID,
    title: "Dune",
    subtitle: null,
    authors: ["Frank Herbert"],
    series: null,
    series_index: null,
    description: null,
    publisher: null,
    published_date: null,
    language: "en",
    isbn10: null,
    isbn13: null,
    tags: [],
    narrator_voice: null,
    cover_url: `/api/v1/books/${BOOK_ID}/cover`,
    status: "ready",
    error: null,
    total_chars: 1200,
    est_duration_s: 600,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** Segments with contiguous char ranges and unique sentence text per segment. */
export function makeSegments(chapterId: string, count: number): Segment[] {
  let cursor = 0;
  return Array.from({ length: count }, (_, i) => {
    const id = `${chapterId}-seg${i}`;
    const text = `One ${id} here. Two ${id} here. Three ${id} here.`;
    const segment = { id, idx: i, text, char_start: cursor, char_end: cursor + text.length };
    cursor += text.length;
    return segment;
  });
}

export interface PlayerFixture {
  chapters?: Chapter[];
  segmentsByChapter?: Record<string, Segment[]>;
  /** segment_id → status override; everything else is "ready". */
  statuses?: Record<string, AudioStatus>;
  duration_s?: number;
  /** The prepare response offers the book as an HLS stream (server TTS_FORMAT=aac). */
  stream?: boolean;
  /** The stream timeline lists only this many entries (default: all, complete). */
  streamListed?: number;
  /** Override the listening settings the player reads (defaults apply). */
  settings?: Partial<ListeningSettings>;
  /** The GET /me/speed-options grid (the pinned default applies). */
  speedOptions?: SpeedOptions;
  /** The caller's saved progress on GET /books/{id} (null until set). */
  progress?: Progress | null;
  /** Overrides merged into the default book payload (e.g. narrator_voice). */
  book?: Partial<Book>;
  /** segment_id → the clip's sentence marks ([text fraction, seconds] pairs). */
  marks?: Record<string, [number, number][]>;
  /** The POST /audio/live answer (default: this server cannot stream). */
  live?: LiveStart;
}

export interface InstalledFetch {
  /** `retry` is only present when the player asked to re-queue failed rows. */
  prepareCalls: { segment_id: string; count: number; voice?: string; retry?: boolean }[];
  /** Every PUT /progress body received, in order. */
  saveCalls: Record<string, unknown>[];
  /** Every PUT /progress/finished body received, in order. */
  finishedCalls: { finished: boolean }[];
  /** When true, progress PUTs answer 500 (the player must stay silent). */
  saveFails: boolean;
  /** Every PATCH /books/{id} body received, in order (narrator changes). */
  patchCalls: Record<string, unknown>[];
  /** Every POST /audio/live body received, in order. */
  liveCalls: { segment_id: string; at: number; voice?: string }[];
}

/** GET /voices: two English voices (one without a display name) and the
 * server default per language. */
export const PLAYER_VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true, display_name: "Ashley" },
    { id: "zoe-en", language: "en", description: null, available: true },
  ],
  defaults: { en: "ashley-en" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function installPlayerFetch(fixture: PlayerFixture = {}): InstalledFetch {
  const chapters = fixture.chapters ?? [
    { id: CH1, idx: 0, title: "Chapter One", char_count: 600 },
    { id: CH2, idx: 1, title: "Chapter Two", char_count: 600 },
  ];
  const byChapter: Record<string, Segment[]> = {
    [CH3]: makeSegments(CH3, 2),
    ...(fixture.segmentsByChapter ?? {
      [CH1]: makeSegments(CH1, 2),
      [CH2]: makeSegments(CH2, 2),
    }),
  };
  const all = Object.values(byChapter).flat();
  const prepareCalls: InstalledFetch["prepareCalls"] = [];
  const saveCalls: InstalledFetch["saveCalls"] = [];
  const finishedCalls: InstalledFetch["finishedCalls"] = [];
  const patchCalls: InstalledFetch["patchCalls"] = [];
  const liveCalls: InstalledFetch["liveCalls"] = [];
  const installed: InstalledFetch = { prepareCalls, saveCalls, finishedCalls, saveFails: false, patchCalls, liveCalls };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/me/speed-options")) {
        return jsonResponse(fixture.speedOptions ?? DEFAULT_SPEED_OPTIONS);
      }
      if (url.includes("/voices")) return jsonResponse(PLAYER_VOICES);
      if (url.match(/\/books\/[^/]+$/) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchCalls.push(body);
        return jsonResponse({ book: { ...makeBook(), ...fixture.book, ...body } });
      }
      if (url.includes("/me/settings")) {
        return jsonResponse({ settings: { ...DEFAULT_SETTINGS, ...fixture.settings } });
      }
      if (url.match(/\/progress\/finished$/) && init?.method === "PUT") {
        finishedCalls.push(JSON.parse(String(init.body)) as { finished: boolean });
        return jsonResponse({ progress: makeProgress({}) });
      }
      if (url.match(/\/books\/[^/]+\/progress$/)) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          saveCalls.push(body);
          if (installed.saveFails) return jsonResponse({ error: { code: "nope", message: "nope" } }, 500);
          return jsonResponse({
            progress: makeProgress({
              chapter_id: String(body.chapter_id),
              segment_id: String(body.segment_id),
              offset_s: Number(body.offset_s),
              device_label: String(body.device_label),
            }),
            ahead_of_other_device: false,
          });
        }
        return jsonResponse({ progress: fixture.progress ?? null });
      }
      if (url.startsWith("/api/v1/audio/")) {
        return new Response("clip", { headers: { "Content-Type": "audio/mpeg" } });
      }
      if (url.includes("/audio/live") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as InstalledFetch["liveCalls"][number];
        liveCalls.push(body);
        return jsonResponse(fixture.live ?? { status: "unavailable", voice: body.voice ?? "ashley-en" });
      }
      if (url.includes("/audio/prepare")) {
        const body = JSON.parse(String(init?.body)) as {
          segment_id: string;
          count: number;
          voice?: string;
          retry?: boolean;
        };
        prepareCalls.push(body);
        const from = Math.max(0, all.findIndex((segment) => segment.id === body.segment_id));
        return jsonResponse({
          // Like the backend: the requested segment plus the next `count` ones.
          // Like the backend: url, duration and marks only once the clip exists.
          items: all.slice(from, from + body.count).map((segment) => {
            const status = fixture.statuses?.[segment.id] ?? "ready";
            const ready = status === "ready";
            return {
              segment_id: segment.id,
              status,
              cache_key: ready ? segment.id : null,
              url: ready ? `/api/v1/audio/${segment.id}` : null,
              duration_s: ready ? fixture.duration_s ?? 10 : null,
              marks: ready ? fixture.marks?.[segment.id] ?? null : null,
            };
          }),
          voice: body.voice ?? "ashley-en",
          stream: fixture.stream ?? false,
        });
      }
      if (url.includes("/stream.json?")) {
        // Like the backend: the book's segments in reading order from `from`.
        const params = new URLSearchParams(url.split("?")[1]);
        const ordered = chapters.flatMap((c) => (byChapter[c.id] ?? []).map((seg) => ({ seg, chapter: c.id })));
        const start = Math.max(0, ordered.findIndex(({ seg }) => seg.id === params.get("from")));
        const tail = ordered.slice(start);
        const listed = tail.slice(0, fixture.streamListed ?? tail.length);
        const d = fixture.duration_s ?? 10;
        return jsonResponse({
          voice: params.get("voice"),
          complete: listed.length === tail.length,
          entries: listed.map(({ seg, chapter }, i) => ({
            segment_id: seg.id,
            chapter_id: chapter,
            start: i * d,
            duration: d,
          })),
        });
      }
      const segments = url.match(/\/books\/[^/]+\/chapters\/([^/]+)\/segments$/);
      if (segments) return jsonResponse({ items: byChapter[segments[1]!] ?? [] });
      if (url.match(/\/books\/[^/]+$/)) {
        if (url.includes(BOOK2_ID)) {
          return jsonResponse({
            book: { ...makeBook(), id: BOOK2_ID, title: "Dune Messiah" },
            chapters: [{ id: CH3, idx: 0, title: "Chapter One", char_count: 1200 }],
            progress: null,
          });
        }
        return jsonResponse({
          book: { ...makeBook(), ...fixture.book },
          chapters,
          progress: fixture.progress ?? null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return installed;
}

/** A saved progress row for fixtures; defaults sit in chapter one, segment 1. */
export function makeProgress(overrides: Partial<Progress>): Progress {
  return {
    chapter_id: CH1,
    segment_id: `${CH1}-seg1`,
    offset_s: 7,
    percent: 50,
    device_label: "Linux a1b2",
    updated_at: "2026-01-02T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

/** Stub play/pause and record which elements played/paused. Call before rendering. */
export function stubMedia(): { played: HTMLMediaElement[]; paused: HTMLMediaElement[] } {
  const played: HTMLMediaElement[] = [];
  const paused: HTMLMediaElement[] = [];
  // Like a browser: play() clears `paused` and pause() sets it again.
  const running = new WeakSet<HTMLMediaElement>();
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
    return !running.has(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    running.add(this);
    // The silent clip iOS needs to unlock an element on the first gesture is a
    // gesture artifact, not playback, so tests that count starts never see it.
    if (this.getAttribute("src") !== SILENT_SRC) played.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    running.delete(this);
    paused.push(this);
    return undefined;
  });
  return { played, paused };
}

let current: PlayerContextValue | undefined;
function Probe() {
  current = usePlayer();
  return null;
}

/** Mount the provider at /player with a probe; returns a getter for the live
 * context plus the QueryClient so tests can spy on cache updates. */
export function renderPlayer(extra?: ReactNode, entries: string[] = ["/player"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries}>
        <PlayerProvider>
          <Probe />
          {extra}
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return Object.assign(() => current!, { client });
}
