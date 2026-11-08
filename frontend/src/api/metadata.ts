/** Typed calls + TanStack hooks for the M3 metadata/covers endpoints (plan T-D contract). */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, api, csrfToken, notifyUnauthenticated } from "./client";
import type { Book, BookDetailResponse, Candidate } from "./types";

/** Body of PATCH /books/{id}; the server appends every provided field to locked_fields. */
export type BookPatch = Partial<
  Pick<
    Book,
    | "title"
    | "subtitle"
    | "authors"
    | "series"
    | "series_index"
    | "description"
    | "publisher"
    | "published_date"
    | "language"
    | "isbn10"
    | "isbn13"
    | "tags"
    | "genre"
    | "narrator_voice"
  >
>;

/** Body of PATCH /books/{id} with the Find-metadata extension: fields listed in
 * metadata_fields are written but not locked (existing locks are removed). */
export type BookSavePatch = BookPatch & { metadata_fields?: string[] };

/** Body of POST /books/{id}/cover and PUT /books/{id}/cover-url. */
export interface CoverResponse {
  cover_url: string | null;
  cover_key: string;
}

/** Saved candidates for the "Review metadata matches" banner. 403s are ignored by the UI. */
export function useMetadataCandidates(id: string) {
  return useQuery({
    queryKey: ["metadata-candidates", id],
    queryFn: () => api.get<{ items: Candidate[] }>(`/books/${id}/metadata/candidates`),
    enabled: Boolean(id),
    retry: false,
  });
}

export function useMetadataSearch(id: string) {
  return useMutation({
    mutationFn: ({ q, isbn }: { q: string; isbn?: string }) => {
      const search = new URLSearchParams();
      if (q) search.set("q", q);
      if (isbn) search.set("isbn", isbn);
      return api.get<{ items: Candidate[] }>(`/books/${id}/metadata/search?${search.toString()}`);
    },
  });
}

/** Optimistic PATCH; the server response is authoritative and replaces the cache.
 * metadata_fields is save metadata, not a book field: it is stripped before the
 * optimistic merge so it never leaks into the cached Book. */
export function useUpdateBook(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Book, Error, BookSavePatch, { prev?: BookDetailResponse }>({
    mutationFn: (patch) => api.patch<{ book: Book }>(`/books/${id}`, patch).then((data) => data.book),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["book", id] });
      const prev = queryClient.getQueryData<BookDetailResponse>(["book", id]);
      const bookPatch = { ...patch };
      delete bookPatch.metadata_fields;
      queryClient.setQueryData<BookDetailResponse>(["book", id], (old) =>
        old ? { ...old, book: { ...old.book, ...bookPatch } } : old,
      );
      return { prev };
    },
    onError: (_error, _patch, context) => {
      if (context?.prev) queryClient.setQueryData(["book", id], context.prev);
    },
    onSuccess: (book) => {
      queryClient.setQueryData<BookDetailResponse>(["book", id], (old) =>
        old ? { ...old, book } : old,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
}

function setCachedCover(queryClient: QueryClient, id: string, data: CoverResponse): void {
  queryClient.setQueryData<BookDetailResponse>(["book", id], (old) =>
    old ? { ...old, book: { ...old.book, cover_url: data.cover_url } } : old,
  );
  void queryClient.invalidateQueries({ queryKey: ["books"] });
}

/** POST /books/{id}/cover with XHR — same pattern as useUpload in api/books.ts. */
function uploadCover(id: string, file: Blob, filename: string): Promise<CoverResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, filename);
    xhr.addEventListener("load", () => {
      if (xhr.status === 401) notifyUnauthenticated();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as CoverResponse);
        } catch {
          reject(new ApiError("request_failed", "Something went wrong.", xhr.status));
        }
        return;
      }
      let code = "request_failed";
      let message = "Something went wrong.";
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
        code = payload.error?.code ?? code;
        message = payload.error?.message ?? message;
      } catch {
        // Non-JSON error body: keep the generic message.
      }
      reject(new ApiError(code, message, xhr.status));
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError("network_error", "Upload failed. Check your connection and try again.", 0)),
    );
    xhr.open("POST", `/api/v1/books/${id}/cover`);
    xhr.withCredentials = true;
    const token = csrfToken();
    if (token) xhr.setRequestHeader("X-CSRF-Token", token);
    xhr.send(form);
  });
}

export function useUploadCover(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, filename }: { file: Blob; filename: string }) =>
      uploadCover(id, file, filename),
    onSuccess: (data) => setCachedCover(queryClient, id, data),
  });
}

export function useSetCoverUrl(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.put<CoverResponse>(`/books/${id}/cover-url`, { url }),
    onSuccess: (data) => setCachedCover(queryClient, id, data),
  });
}

/** DELETE /books/{id}/cover → 204; the cover_url becomes null. */
export function useDeleteCover(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/books/${id}/cover`),
    onSuccess: () => {
      queryClient.setQueryData<BookDetailResponse>(["book", id], (old) =>
        old ? { ...old, book: { ...old.book, cover_url: null } } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
}

/** POST /books/{id}/unlock {field}: removes one field from locked_fields. */
export function useUnlockField(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (field: string) =>
      api.post<{ book: Book }>(`/books/${id}/unlock`, { field }).then((data) => data.book),
    onSuccess: (book) => {
      queryClient.setQueryData<BookDetailResponse>(["book", id], (old) =>
        old ? { ...old, book } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
}
