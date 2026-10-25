/** Typed calls + hooks for the M5 progress endpoints (plan Task Q contract).
 * saveProgress is a plain function, not a hook, so the player can call it
 * from timers and unload events. It uses fetch(..., { keepalive: true }) with
 * the CSRF header instead of the api client or sendBeacon: the page may
 * unload mid-save and sendBeacon cannot set headers (docs/DECISIONS.md).
 * A failed save returns null — saving is silent by design, the next tick
 * retries. */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE, api, csrfToken } from "./client";
import type { Book, Progress } from "./types";

export type { Progress };

/** Body of PUT /books/{id}/progress. */
export interface ProgressSaveBody {
  chapter_id: string;
  segment_id: string;
  offset_s: number;
  device_label: string;
}

export interface SaveResult {
  progress: Progress;
  ahead_of_other_device: boolean;
}

/** Entry of GET /me/continue. */
export interface ContinueItem {
  book: Book;
  progress: Progress;
}

export const continueQueryKey = ["continue"] as const;

export function progressQueryKey(bookId: string) {
  return ["progress", bookId] as const;
}

export function useBookProgress(bookId: string) {
  return useQuery({
    queryKey: progressQueryKey(bookId),
    queryFn: async () => (await api.get<{ progress: Progress | null }>(`/books/${bookId}/progress`)).progress,
    enabled: Boolean(bookId),
  });
}

/** Upsert the caller's progress row; null on any failure (silent). */
export async function saveProgress(bookId: string, body: ProgressSaveBody): Promise<SaveResult | null> {
  try {
    const token = csrfToken();
    const response = await fetch(`${API_BASE}/books/${bookId}/progress`, {
      method: "PUT",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as SaveResult;
  } catch {
    return null; // offline / unload: playback continues, the next tick retries
  }
}

export function markFinished(bookId: string, finished: boolean): Promise<{ progress: Progress }> {
  return api.put<{ progress: Progress }>(`/books/${bookId}/progress/finished`, { finished });
}

export function resetProgress(bookId: string): Promise<undefined> {
  return api.del<undefined>(`/books/${bookId}/progress`);
}

export function useContinueListening(limit = 10) {
  return useQuery({
    queryKey: [...continueQueryKey, limit],
    queryFn: () => api.get<{ items: ContinueItem[] }>(`/me/continue?limit=${limit}`),
  });
}

export const finishedQueryKey = ["finished"] as const;

/** Finished shelf: GET /me/finished, finished_at desc (plan M6 Task A3). */
export function useFinishedListening(limit = 12) {
  return useQuery({
    queryKey: [...finishedQueryKey, limit],
    queryFn: () => api.get<{ items: ContinueItem[] }>(`/me/finished?limit=${limit}`),
  });
}

export interface ProgressMembership {
  progressById: Map<string, Progress>;
  inProgress: Set<string>;
  finished: Set<string>;
}

/** Which books are in progress / finished, and their progress rows. The API
 * exposes no per-book progress on /books, so membership comes from
 * /me/continue and /me/finished (capped at 50 each, docs/DECISIONS.md). */
export function useProgressMembership(): ProgressMembership {
  const { data: continueData } = useContinueListening(50);
  const { data: finishedData } = useFinishedListening(50);
  return useMemo(() => {
    const progressById = new Map<string, Progress>();
    const inProgress = new Set<string>();
    const finished = new Set<string>();
    for (const item of continueData?.items ?? []) {
      progressById.set(item.book.id, item.progress);
      if (item.progress.finished_at) finished.add(item.book.id);
      else inProgress.add(item.book.id);
    }
    for (const item of finishedData?.items ?? []) {
      progressById.set(item.book.id, item.progress);
      finished.add(item.book.id);
    }
    return { progressById, inProgress, finished };
  }, [continueData, finishedData]);
}

const DEVICE_KEY = "folio-device";

/** Stable per-browser label: readable platform + 4-char id, max 64 chars. */
export function deviceLabel(): string {
  let label = localStorage.getItem(DEVICE_KEY);
  if (!label) {
    const platform = navigator.platform?.trim() || "Browser";
    label = `${platform} ${crypto.randomUUID().slice(0, 4)}`.slice(0, 64);
    localStorage.setItem(DEVICE_KEY, label);
  }
  return label;
}

const POS_PREFIX = "folio-pos-";

/** Remember where this browser stopped in a book (for the ahead-of-device check). */
export function rememberPosition(bookId: string, progress: Progress): void {
  localStorage.setItem(`${POS_PREFIX}${bookId}`, JSON.stringify(progress));
}

export function readPosition(bookId: string): Progress | null {
  try {
    const raw = localStorage.getItem(`${POS_PREFIX}${bookId}`);
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}

/** How far `server` is ahead of `local`, in seconds, on the book's character
 * timeline (percent is character-based; seconds come from the duration
 * estimate, falling back to the spec's 15 chars/second). */
export function secondsAhead(server: Progress, local: Progress, book: Book): number {
  const secondsPerChar =
    book.est_duration_s && book.total_chars ? book.est_duration_s / book.total_chars : 1 / 15;
  return (Math.max(0, server.percent - local.percent) * (book.total_chars || 0) * secondsPerChar) / 100;
}
