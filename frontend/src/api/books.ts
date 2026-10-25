/** Typed calls + queries for the books endpoints (plan T8 contract). */
import { useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api, csrfToken } from "./client";
import type { BookDetailResponse, BookListResponse, Chapter, UploadResult } from "./types";

export type BookSort = "recent" | "title" | "author" | "progress";

export interface BookListParams {
  q?: string;
  sort?: BookSort;
  status?: string;
  page?: number;
}

export function useBooks(params: BookListParams) {
  return useQuery({
    queryKey: ["books", params],
    queryFn: () => {
      const search = new URLSearchParams();
      if (params.q) search.set("q", params.q);
      if (params.sort) search.set("sort", params.sort);
      if (params.status) search.set("status", params.status);
      if (params.page && params.page > 1) search.set("page", String(params.page));
      const qs = search.toString();
      return api.get<BookListResponse>(`/books${qs ? `?${qs}` : ""}`);
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

/** Admin/uploader: include a chapter in playback or exclude it from it. */
export function useSetChapterExcluded(bookId: string) {
  return useMutation({
    mutationFn: ({ chapterId, excluded }: { chapterId: string; excluded: boolean }) =>
      api.patch<{ chapter: Chapter }>(`/books/${bookId}/chapters/${chapterId}`, { excluded }),
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
