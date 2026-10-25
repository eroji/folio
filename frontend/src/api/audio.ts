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
}

/** Row of GET /books/{id}/chapters/{chapter_id}/segments. */
export interface Segment {
  id: string;
  idx: number;
  text: string;
  char_start: number;
  char_end: number;
}

export function prepareAudio(
  bookId: string,
  segmentId: string,
  count: number,
  voice?: string,
): Promise<PrepareResponse> {
  return api.post<PrepareResponse>(`/books/${bookId}/audio/prepare`, {
    segment_id: segmentId,
    count,
    ...(voice ? { voice } : {}),
  });
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
