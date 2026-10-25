/** Typed call + query for GET /search?q=&type= (handoff §5.4). */
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { Book } from "./types";

export type SearchType = "all" | "books" | "authors" | "series";

export interface SearchGroup {
  name: string;
  count: number;
}

export type SearchTop =
  | { type: "author"; name: string; count: number; finished: number }
  | { type: "book"; book: Book };

export interface SearchResponse {
  top: SearchTop | null;
  books: Book[];
  authors: SearchGroup[];
  series: SearchGroup[];
}

export function useSearch(q: string, type: SearchType) {
  return useQuery({
    queryKey: ["search", q, type],
    queryFn: () =>
      api.get<SearchResponse>(`/search?${new URLSearchParams({ q, type }).toString()}`),
    enabled: q.length > 0,
  });
}
