/** Shared fixtures for the player tests: fake book/chapter/segment endpoints
 * plus HTMLMediaElement play/pause stubs (jsdom has no audio backend). */
import { vi } from "vitest";
import type { Book, Chapter } from "../api/types";
import type { AudioStatus, Segment } from "../api/audio";

export const BOOK_ID = "11111111-1111-1111-1111-111111111111";
export const CH1 = "c1111111-1111-1111-1111-111111111111";
export const CH2 = "c2222222-2222-2222-2222-222222222222";

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

export function makeSegments(chapterId: string, count: number): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${chapterId}-seg${i}`,
    idx: i,
    text: `Sentence one of ${chapterId}-seg${i}. Sentence two here. Sentence three ends.`,
    char_start: i * 200,
    char_end: (i + 1) * 200,
  }));
}

export interface PlayerFixture {
  chapters?: Chapter[];
  segmentsByChapter?: Record<string, Segment[]>;
  /** segment_id → status override; everything else is "ready". */
  statuses?: Record<string, AudioStatus>;
  duration_s?: number;
}

export interface InstalledFetch {
  prepareCalls: { segment_id: string; count: number }[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function installPlayerFetch(fixture: PlayerFixture = {}): InstalledFetch {
  const chapters = fixture.chapters ?? [
    { id: CH1, idx: 1, title: "Chapter One", char_count: 600 },
    { id: CH2, idx: 2, title: "Chapter Two", char_count: 600 },
  ];
  const byChapter = fixture.segmentsByChapter ?? {
    [CH1]: makeSegments(CH1, 2),
    [CH2]: makeSegments(CH2, 2),
  };
  const all = Object.values(byChapter).flat();
  const prepareCalls: InstalledFetch["prepareCalls"] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/audio/prepare")) {
        const body = JSON.parse(String(init?.body)) as { segment_id: string; count: number };
        prepareCalls.push(body);
        return jsonResponse({
          items: all.map((segment) => ({
            segment_id: segment.id,
            status: fixture.statuses?.[segment.id] ?? "ready",
            cache_key: segment.id,
            url: `/api/v1/audio/${segment.id}`,
            duration_s: fixture.duration_s ?? 10,
          })),
        });
      }
      const segments = url.match(/\/books\/[^/]+\/chapters\/([^/]+)\/segments$/);
      if (segments) return jsonResponse({ items: byChapter[segments[1]!] ?? [] });
      if (url.match(/\/books\/[^/]+$/)) return jsonResponse({ book: makeBook(), chapters, progress: null });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return { prepareCalls };
}

/** Stub play/pause and record which elements played. Call before rendering. */
export function stubMedia(): { played: HTMLMediaElement[] } {
  const played: HTMLMediaElement[] = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  return { played };
}
