import clsx from "clsx";
import { X } from "lucide-react";
import type { Book, Chapter } from "../api/types";

function estimateSeconds(book: Book, chapter: Chapter): number {
  // Chars-per-second from the book's own estimate; 15 chars/s is the usual
  // narration fallback when a book has no est_duration_s.
  const perChar = book.est_duration_s != null && book.total_chars > 0 ? book.est_duration_s / book.total_chars : 1 / 15;
  return chapter.char_count * perChar;
}

function formatLength(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** Chapter list sheet (spec "Player behavior"): title + estimated length. */
export function ChapterSheet({
  book,
  chapters,
  currentId,
  onSelect,
  onClose,
}: {
  book: Book;
  chapters: Chapter[];
  currentId: string | null;
  onSelect: (chapterId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40">
      <button type="button" tabIndex={-1} aria-hidden className="absolute inset-0 cursor-default bg-ink/50" onClick={onClose} />
      <div role="dialog" aria-label="Chapters" className="absolute inset-x-0 bottom-0 flex max-h-[70dvh] flex-col rounded-t-card bg-card pb-safe">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-display text-lg font-semibold">Chapters</h2>
          <button
            type="button"
            aria-label="Close chapters"
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-pill text-muted hover:text-ink"
          >
            <X size={20} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <ol className="divide-y divide-line overflow-y-auto px-2 pb-2">
          {chapters.map((chapter) => (
            <li key={chapter.id}>
              <button
                type="button"
                disabled={chapter.id === currentId}
                onClick={() => onSelect(chapter.id)}
                className={clsx(
                  "flex min-h-11 w-full items-center justify-between gap-3 rounded-card px-3 py-2 text-left text-sm",
                  chapter.id === currentId ? "font-medium text-brand-blue" : "hover:bg-page",
                )}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="tabular-nums text-muted">{chapter.idx}</span>
                  <span className="truncate">{chapter.title}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{formatLength(estimateSeconds(book, chapter))}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
