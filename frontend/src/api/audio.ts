/** Typed calls + queries for the M4 audio endpoints (plan Task B contract).
 * Types stay local to this module; api/types.ts is the shared M1–M3 contract. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { BookDetailResponse } from "./types";

export type AudioStatus = "queued" | "generating" | "ready" | "failed";

/** One entry of the POST /books/{id}/audio/prepare response. `url` is the
 * playable /api/v1/audio/{key} path when status is "ready". */
export interface PreparedSegment {
  segment_id: string;
  status: AudioStatus;
  cache_key: string | null;
  url: string | null;
  duration_s: number | null;
  /** Where each sentence starts in the clip: [text fraction, seconds] pairs
   * (player/marks.ts); null for a clip made as one request. */
  marks?: [number, number][] | null;
}

export interface LeadIn {
  cache_key: string;
  url: string;
  duration_s: number;
  text: string;
}

export interface PrepareResponse {
  items: PreparedSegment[];
  lead_in?: LeadIn;
  /** The voice the server resolved (and keys the clips by). */
  voice?: string;
  /** The book can be played as one HLS stream in `voice` (server TTS_FORMAT=aac). */
  stream?: boolean;
}

/** One listed clip of a book stream, in seconds from the stream's origin. */
export interface StreamEntry {
  segment_id: string;
  chapter_id: string;
  start: number;
  duration: number;
}

/** GET /books/{id}/stream.json: the HLS stream's timeline from `origin`. */
export interface StreamTimeline {
  voice: string;
  complete: boolean;
  entries: StreamEntry[];
}

function streamQuery(voice: string, origin: string): string {
  return `voice=${encodeURIComponent(voice)}&from=${encodeURIComponent(origin)}`;
}

/** The book from `origin` on as one HLS playlist (Safari plays it natively). */
export function streamPlaylistUrl(bookId: string, voice: string, origin: string): string {
  return `/api/v1/books/${bookId}/stream.m3u8?${streamQuery(voice, origin)}`;
}

export function fetchStreamTimeline(bookId: string, voice: string, origin: string): Promise<StreamTimeline> {
  return api.get<StreamTimeline>(`/books/${bookId}/stream.json?${streamQuery(voice, origin)}`);
}

/** Row of GET /books/{id}/chapters/{chapter_id}/segments. */
export interface Segment {
  id: string;
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
}

const PREPARE_TIMEOUT_MS = 20_000;

export function prepareAudio(
  bookId: string,
  segmentId: string,
  count: number,
  voice?: string,
): Promise<PrepareResponse> {
  // A request that never settles would block every later prepare (the player
  // keeps one in flight). Fail it, show Retry, and let the poll try again.
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(
      () => reject(new Error("Audio preparation timed out. Try again.")),
      PREPARE_TIMEOUT_MS,
    );
  });
  return Promise.race([
    api.post<PrepareResponse>(`/books/${bookId}/audio/prepare`, {
      segment_id: segmentId,
      count,
      ...(voice ? { voice } : {}),
    }),
    timeout,
  ]);
}

export function segmentsForChapter(bookId: string, chapterId: string): Promise<{ items: Segment[] }> {
  return api.get(`/books/${bookId}/chapters/${chapterId}/segments`);
}

export function fetchSegments(bookId: string, chapterId: string): Promise<Segment[]> {
  return segmentsForChapter(bookId, chapterId).then((res) => res.items);
}

/** GET /books/{id} — book + chapter list (progress stays null until M5). */
export function fetchBookDetail(bookId: string): Promise<BookDetailResponse> {
  return api.get<BookDetailResponse>(`/books/${bookId}`);
}

export function useChapters(bookId: string) {
  return useQuery({
    queryKey: ["book", bookId], // Same key useBook writes: SSE book frames refresh it.
    queryFn: () => fetchBookDetail(bookId),
    enabled: Boolean(bookId),
  });
}

export function useSegments(bookId: string, chapterId: string) {
  return useQuery({
    queryKey: ["segments", bookId, chapterId],
    queryFn: () => fetchSegments(bookId, chapterId),
    enabled: Boolean(bookId && chapterId),
  });
}

/** One ready clip (its `/api/v1/audio/{key}` URL) as a Blob, so the player can
 * switch to it at a boundary without waiting on the network. */
export function fetchAudioClip(url: string): Promise<Blob> {
  return api.blob(url);
}
