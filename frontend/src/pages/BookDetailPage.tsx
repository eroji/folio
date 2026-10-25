import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, Play } from "lucide-react";
import { useBook, useDeleteBook, useReprocessBook, useSetChapterExcluded } from "../api/books";
import { useMetadataCandidates, useUpdateBook } from "../api/metadata";
import { continueQueryKey, markFinished, progressQueryKey, resetProgress, useBookProgress } from "../api/progress";
import { useAuth } from "../auth/AuthProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "../components/BookCard";
import { FindMetadata } from "../components/FindMetadata";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { VoicePicker } from "../components/VoicePicker";
import { AlertTriangle, BookOpen } from "lucide-react";
import type { BookDetailResponse, Candidate, Chapter } from "../api/types";

function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Include-in-playback switch (44 px target, visual track inside). */
function ChapterSwitch({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className="grid min-h-11 min-w-11 shrink-0 place-items-center"
    >
      <span
        aria-hidden
        className={clsx("flex h-6 w-11 items-center rounded-pill p-0.5 transition-colors", checked ? "bg-brand-blue" : "bg-line")}
      >
        <span className={clsx("h-5 w-5 rounded-pill bg-card shadow transition-transform", checked && "translate-x-5")} />
      </span>
    </button>
  );
}

/** Screen 4. Sticky Play/Resume bar, collapsible chapters, chapter manager for admins. */
export function BookDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const player = usePlayer();
  const { data, isPending, error } = useBook(id);
  const reprocess = useReprocessBook(id);
  const remove = useDeleteBook(id);
  const update = useUpdateBook(id);
  const progressQuery = useBookProgress(id);
  function invalidateProgress() {
    queryClient.invalidateQueries({ queryKey: ["book", id] });
    queryClient.invalidateQueries({ queryKey: progressQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: continueQueryKey });
  }
  const toggleFinished = useMutation({
    mutationFn: (value: boolean) => markFinished(id, value),
    onSuccess: invalidateProgress,
  });
  const reset = useMutation({ mutationFn: () => resetProgress(id), onSuccess: invalidateProgress });
  const [findOpen, setFindOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<Candidate[] | null>(null);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const candidates = useMetadataCandidates(id);

  // Optimistic exclude/include; the cache stays authoritative for the session
  // because the server may omit excluded chapters from GET /books/{id}.
  const setChapter = useSetChapterExcluded(id);
  function toggleChapter(chapter: Chapter) {
    const excluded = !chapter.excluded;
    const write = (value: boolean) =>
      queryClient.setQueryData<BookDetailResponse>(["book", id], (prev) =>
        prev ? { ...prev, chapters: prev.chapters.map((c) => (c.id === chapter.id ? { ...c, excluded: value } : c)) } : prev,
      );
    write(excluded);
    setChapter.mutate(
      { chapterId: chapter.id, excluded },
      {
        onError: () => write(!excluded),
      },
    );
  }

  if (error instanceof Error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={28} strokeWidth={1.75} aria-hidden />}
        title="Book not found"
        description={error.message}
        action={
          <Link to="/" className="text-sm font-medium text-brand-blue underline">
            Back to library
          </Link>
        }
      />
    );
  }

  if (isPending || !data) {
    return (
      <div className="animate-pulse" aria-busy="true">
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="aspect-[2/3] w-40 rounded-card bg-card md:w-56" />
          <div className="flex-1 space-y-3">
            <div className="h-8 w-2/3 rounded bg-card" />
            <div className="h-4 w-1/2 rounded bg-card" />
            <div className="h-24 rounded-card bg-card" />
          </div>
        </div>
      </div>
    );
  }

  const { book } = data;
  const included = data.chapters.filter((chapter) => !chapter.excluded);
  const excludedChapters = data.chapters.filter((chapter) => chapter.excluded);
  const saved = candidates.data?.items ?? [];
  const length = formatDuration(book.est_duration_s);
  const series = book.series ? `${book.series}${book.series_index != null ? ` #${book.series_index}` : ""}` : null;
  const firstChapter = included[0];
  const notPlayable = book.status === "needs_ocr" || book.status === "failed" || !firstChapter;
  const progress = progressQuery.data ?? data.progress;
  const finished = Boolean(progress?.finished_at);
  // TODO(M5): the spec also allows the uploader; the Book payload does not expose
  // uploaded_by, so until it does only admins see the manager and Reprocess/Delete.
  const canManage = user?.role === "admin";
  const resumeChapterId = progress?.chapter_id ?? firstChapter?.id;
  const playHref = resumeChapterId ? `/player?book=${book.id}&chapter=${resumeChapterId}` : "";
  const percent = progress ? Math.round(progress.percent) : null;

  const chapterRow = (chapter: Chapter, withLink: boolean) => (
    <li key={chapter.id} className="flex min-h-11 items-center gap-3 px-4 py-1">
      {withLink ? (
        <Link to={`/player?book=${book.id}&chapter=${chapter.id}`} className="flex min-w-0 flex-1 items-baseline gap-2 py-2 text-sm">
          <span className="tabular-nums text-muted">{chapter.idx}</span>
          <span className="truncate">{chapter.title}</span>
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm text-muted">
          <span className="tabular-nums">{chapter.idx}</span>
          <span className="truncate">{chapter.title}</span>
        </span>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted">{chapter.char_count.toLocaleString()} chars</span>
      {canManage && (
        <ChapterSwitch
          checked={withLink}
          label={`Include ${chapter.title} in playback`}
          onToggle={() => toggleChapter(chapter)}
        />
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-6 pb-28">
      <div className="flex flex-col gap-6 md:flex-row">
        <BookCover book={book} className="aspect-[2/3] w-40 shrink-0 self-center rounded-card md:w-56" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-semibold">{book.title}</h1>
              <p className="text-muted">{book.authors.join(", ")}</p>
              {series && <p className="text-sm text-muted">{series}</p>}
            </div>
            <StatusBadge status={book.status} />
            {finished && (
              <span className="rounded-pill bg-brand-violet/15 px-3 py-1 text-xs font-medium text-brand-violet">Finished</span>
            )}
          </div>

          {book.status === "failed" && book.error && (
            <p role="alert" className="rounded-card border border-danger/40 bg-page px-3 py-2 text-sm text-danger">
              {book.error}
            </p>
          )}

          <p className="text-sm text-muted">
            {[book.language, length && `about ${length}`].filter(Boolean).join(" · ")}
          </p>

          {book.description && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer font-medium text-brand-blue">Description</summary>
              <p className="whitespace-pre-line text-muted">{book.description}</p>
            </details>
          )}

          <div className="flex flex-col gap-1">
            <h2 className="font-display text-lg font-semibold">Narrator voice</h2>
            <VoicePicker
              value={book.narrator_voice}
              language={book.language}
              onChange={(voice) => update.mutate({ narrator_voice: voice })}
            />
            {update.isError && (
              <p role="alert" className="text-sm text-danger">
                {update.error.message}
              </p>
            )}
          </div>

          {/* Overflow row: book actions for every signed-in user; the server
              enforces uploader-or-admin and the 403 message surfaces inline. */}
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/books/${id}/edit`}
              className="inline-flex min-h-11 items-center rounded-pill border border-line bg-card px-4 text-sm font-medium"
            >
              Edit
            </Link>
            <button
              type="button"
              aria-expanded={findOpen}
              onClick={() => {
                setReviewItems(null);
                setFindOpen((open) => !open);
              }}
              className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium"
            >
              Find metadata
            </button>
            {canManage && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    reprocess.mutate(undefined, {
                      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", id] }),
                    })
                  }
                  disabled={reprocess.isPending}
                  className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
                >
                  Reprocess
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete “${book.title}” from the library?`)) {
                      remove.mutate(undefined, {
                        onSuccess: () => {
                          queryClient.invalidateQueries({ queryKey: ["books"] });
                          navigate("/");
                        },
                      });
                    }
                  }}
                  disabled={remove.isPending}
                  className="min-h-11 rounded-pill border border-danger/40 px-4 text-sm font-medium text-danger disabled:opacity-50"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {/* Progress actions: per-user, shown to every signed-in user. */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => toggleFinished.mutate(!finished)}
              disabled={toggleFinished.isPending}
              className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
            >
              {finished ? "Mark unfinished" : "Mark finished"}
            </button>
            {progress && (
              <button
                type="button"
                onClick={() => reset.mutate()}
                disabled={reset.isPending}
                className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
              >
                Reset progress
              </button>
            )}
          </div>

          {saved.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-brand-blue/40 bg-page px-3 py-2">
              <p className="text-sm text-muted">Online matches were found but not applied automatically.</p>
              <button
                type="button"
                onClick={() => {
                  setReviewItems(saved);
                  setFindOpen(true);
                }}
                className="min-h-11 rounded-pill bg-brand-blue px-4 text-sm font-medium text-white"
              >
                Review metadata matches
              </button>
            </div>
          )}

          {findOpen && <FindMetadata book={book} initialItems={reviewItems ?? undefined} />}

          {data.chapters.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={chaptersOpen}
                onClick={() => setChaptersOpen((open) => !open)}
                className="flex min-h-11 items-center justify-between gap-2 rounded-card border border-line bg-card px-4 text-left font-display font-semibold"
              >
                <span className="flex items-center gap-2">
                  <BookOpen size={18} strokeWidth={1.75} aria-hidden />
                  Chapters ({included.length})
                </span>
                <ChevronDown size={18} strokeWidth={1.75} aria-hidden className={clsx("transition-transform", chaptersOpen && "rotate-180")} />
              </button>
              {chaptersOpen && (
                <>
                  <ol className="divide-y divide-line rounded-card border border-line bg-card">
                    {included.map((chapter) => chapterRow(chapter, true))}
                  </ol>
                  {setChapter.isError && (
                    <p role="alert" className="text-sm text-danger">
                      {setChapter.error.message}
                    </p>
                  )}
                  {canManage && excludedChapters.length > 0 && (
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        type="button"
                        aria-expanded={excludedOpen}
                        onClick={() => setExcludedOpen((open) => !open)}
                        className="flex min-h-11 items-center justify-between gap-2 rounded-card border border-line px-4 text-left text-sm font-medium text-muted"
                      >
                        <span>Excluded chapters ({excludedChapters.length})</span>
                        <ChevronDown
                          size={18}
                          strokeWidth={1.75}
                          aria-hidden
                          className={clsx("transition-transform", excludedOpen && "rotate-180")}
                        />
                      </button>
                      {excludedOpen && (
                        <ol className="divide-y divide-line rounded-card border border-line bg-card">
                          {excludedChapters.map((chapter) => chapterRow(chapter, false))}
                        </ol>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sticky action bar, pinned above the bottom nav and the mini player. */}
      <div
        data-testid="book-actions"
        className={clsx(
          // Fixed to the viewport (sticky only pins inside its parent, which is
          // shorter than the screen on desktop). Offsets clear nav + mini player.
          "fixed inset-x-0 z-20 border-t border-line bg-page px-4 pb-3 pt-3 shadow-[0_-8px_24px_-16px_rgba(0,0,0,0.35)]",
          player.book
            ? "bottom-[calc(7rem+env(safe-area-inset-bottom))]"
            : "bottom-[calc(3.5rem+env(safe-area-inset-bottom))]",
        )}
      >
        <div className="mx-auto flex max-w-md flex-col items-stretch gap-1 md:max-w-5xl md:flex-row md:items-center md:gap-4">
          {notPlayable ? (
            <button
              type="button"
              disabled
              className="inline-flex h-14 items-center justify-center gap-2 rounded-pill bg-brand-gradient px-6 font-display font-semibold text-white opacity-50 disabled:cursor-not-allowed"
            >
              No playable chapters
            </button>
          ) : (
            <Link
              to={playHref}
              className="inline-flex h-14 items-center justify-center gap-2 rounded-pill bg-brand-gradient px-6 font-display font-semibold text-white md:ml-auto md:w-72 md:shrink-0"
            >
              <Play size={20} strokeWidth={1.75} aria-hidden />
              {percent != null ? `Resume ${percent}%` : "Play"}
            </Link>
          )}
          {progress && (
            <div className="flex items-center gap-2 pt-1 md:flex-1 md:pt-0">
              <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-pill bg-line">
                <div className="h-full rounded-pill bg-brand-gradient" style={{ width: `${Math.min(100, progress.percent)}%` }} />
              </div>
              <span className="text-xs tabular-nums text-muted">{percent}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
