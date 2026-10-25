import { useSearchParams } from "react-router-dom";
import { useBooks } from "../api/books";
import { useProgressMembership } from "../api/progress";
import { SearchResults } from "./LibraryPage";

/** Search page (Direction D): the top bar field holds the query and Enter
 * lands here with ?q=. Phase 6 redesigns this screen; for now it reuses the
 * library's result rows. */
export function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const { data, isPending, error } = useBooks({ q: query || undefined });
  const { progressById } = useProgressMembership();

  if (!query) {
    return <p className="text-sm text-fg-2">Type in the search field to find books, authors and series.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
      {isPending && !error && (
        <div className="flex flex-col gap-1" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-raised" />
          ))}
        </div>
      )}
      {data && (
        <SearchResults query={query} books={data.items} total={data.total} progressById={progressById} />
      )}
    </div>
  );
}
