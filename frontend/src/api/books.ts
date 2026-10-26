/** Typed calls + queries for the books endpoints (plan T8 contract). */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, csrfToken } from "./client";
import type {
  Book,
  BookDetailResponse,
  BookListResponse,
  Chapter,
  Progress,
  UploadResult,
} from "./types";

export type BookSort = "recent" | "title" | "author" | "progress";
export type BookGroup = "genre" | "author" | "language" | "status" | "none";

/** "English" for "en", "Chinese, Traditional"… for a book's language code. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split("-")[0]!) ?? code;
  } catch {
    return code;
  }
}

/** The language's own name — "日本語" for "ja" (the references' chip labels). */
export function nativeLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code.split("-")[0]!) ?? code;
  } catch {
    return code;
  }
}

/** "4 h 12 m" / "36 m" — the handoff's length and time-left shape. */
export function formatLength(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;
}

export interface BookListParams {
  q?: string;
  sort?: BookSort;
  status?: string;
  genre?: string;
  page?: number;
}

/** One shelf of the grouped GET /books response (handoff §5.1); books carries
 * the first 12 of the group, "See all" pages through the flat listing. */
export interface BookGroupShelf {
  key: string | null;
  label: string;
  count: number;
  books: Book[];
}

function bookListUrl(params: BookListParams & { group?: BookGroup }): string {
  const search = new URLSearchParams();
  for (const key of ["q", "sort", "status", "genre", "group"] as const) {
    const value = params[key];
    if (value) search.set(key, value);
  }
  if (params.page && params.page > 1) search.set("page", String(params.page));
  const qs = search.toString();
  return `/books${qs ? `?${qs}` : ""}`;
}

export function useBooks(params: BookListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["books", params],
    queryFn: () => api.get<BookListResponse>(bookListUrl(params)),
    enabled: options.enabled ?? true,
  });
}

/** Grouped listing: {groups: [{key, label, count, books}]} with the first 12
 * books per group (the API ignores paging in this mode). */
export function useBookGroups(params: BookListParams & { group: BookGroup }, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["books", params],
    queryFn: () => api.get<{ groups: BookGroupShelf[] }>(bookListUrl(params)),
    enabled: options.enabled ?? true,
  });
}

/** Body of GET /me/home (handoff §5.3): the three Home shelves. */
export interface HomeChapter {
  id: string;
  idx: number;
  /** 1-based position among included chapters (both /me/home shelves). */
  number?: number;
  title: string;
  duration_s?: number;
}

export interface HomeContinueItem {
  book: Book;
  progress: Progress;
  chapter: HomeChapter | null;
  time_left_s: number;
}

export interface HomeNextItem {
  book: Book;
  chapter: HomeChapter;
}

export interface HomeResponse {
  continue: HomeContinueItem[];
  next_chapters: HomeNextItem[];
  recent: Book[];
}

export interface HomeFilters {
  status?: "in_progress" | "not_started" | "finished";
  language?: string;
  maxMinutes?: number;
}

export function useHome(filters: HomeFilters) {
  return useQuery({
    queryKey: ["home", filters],
    queryFn: () => {
      const search = new URLSearchParams();
      if (filters.status) search.set("status", filters.status);
      if (filters.language) search.set("language", filters.language);
      if (filters.maxMinutes) search.set("max_minutes", String(filters.maxMinutes));
      const qs = search.toString();
      return api.get<HomeResponse>(`/me/home${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useBook(id: string) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: () => api.get<BookDetailResponse>(`/books/${id}`),
    enabled: Boolean(id),
  });
}

export function useReprocessBook(id: string) {
  return useMutation({ mutationFn: () => api.post(`/books/${id}/reprocess`) });
}

export function useDeleteBook(id: string) {
  return useMutation({ mutationFn: () => api.del<undefined>(`/books/${id}`) });
}

/** Admin/uploader: include a chapter in playback or exclude it from it.
 * Optimistically flips `excluded` in the ["book", id] cache so the Chapters
 * tab and the "N of M included" count update at once; success invalidates so
 * the server's recomputed totals land, error restores the previous cache. */
export function useSetChapterExcluded(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chapterId, excluded }: { chapterId: string; excluded: boolean }) =>
      api.patch<{ chapter: Chapter }>(`/books/${bookId}/chapters/${chapterId}`, { excluded }),
    onMutate: async ({ chapterId, excluded }) => {
      await queryClient.cancelQueries({ queryKey: ["book", bookId] });
      const previous = queryClient.getQueryData<BookDetailResponse>(["book", bookId]);
      queryClient.setQueryData<BookDetailResponse>(["book", bookId], (prev) =>
        prev
          ? {
              ...prev,
              chapters: prev.chapters.map((c) => (c.id === chapterId ? { ...c, excluded } : c)),
            }
          : prev,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["book", bookId], context.previous);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["book", bookId] });
    },
  });
}

/** Uploads one file with XHR — fetch has no upload progress events.
 * One request per file so each row gets its own progress and result. */
export function useUpload() {
  const upload = useCallback(
    (file: File, onProgress: (percent: number) => void) =>
      new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const form = new FormData();
        form.append("files", file);
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve((JSON.parse(xhr.responseText) as UploadResult[])[0]!);
            } catch {
              reject(new ApiError("request_failed", "Something went wrong.", xhr.status));
            }
            return;
          }
          let code = "request_failed";
          let message = "Something went wrong.";
          try {
            const payload = JSON.parse(xhr.responseText) as {
              error?: { code?: string; message?: string };
            };
            code = payload.error?.code ?? code;
            message = payload.error?.message ?? message;
          } catch {
            // Non-JSON error body: keep the generic message.
          }
          reject(new ApiError(code, message, xhr.status));
        });
        xhr.addEventListener("error", () =>
          reject(
            new ApiError("network_error", "Upload failed. Check your connection and try again.", 0),
          ),
        );
        xhr.open("POST", "/api/v1/books");
        xhr.withCredentials = true;
        const token = csrfToken();
        if (token) xhr.setRequestHeader("X-CSRF-Token", token);
        xhr.send(form);
      }),
    [],
  );
  return { upload };
}
