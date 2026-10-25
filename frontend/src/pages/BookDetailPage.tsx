import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Play } from "lucide-react";
import { useBook, useDeleteBook, useReprocessBook, useSetChapterExcluded } from "../api/books";
import { useMetadataCandidates, useUpdateBook } from "../api/metadata";
import { continueQueryKey, markFinished, progressQueryKey, resetProgress, useBookProgress } from "../api/progress";
import { useAuth } from "../auth/AuthProvider";
import { BookCover } from "../components/BookCard";
import { FindMetadata } from "../components/FindMetadata";
import { PronunciationRules } from "../components/PronunciationRules";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { VoicePicker } from "../components/VoicePicker";
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

/** Screen 4. Cover play overlay + progress badge, chapter picker, narrator
 * picker, quiet actions row, and the admin/uploader "Book settings" panel.
 * Playback itself lives in the mini player, so there is no fixed bar here. */
export function BookDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const reset = useMutation({ mutationFn: () => resetProgress(id) });
  const [findOpen, setFindOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<Candidate[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [chapterId, setChapterId] = useState<string | null>(null);
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
  // can_edit is server-computed (admin or uploader, plan M6 A4); payloads
  // predating it fall back to admin-only. The server enforces either way.
  const canManage = book.can_edit ?? user?.role === "admin";
  const resumeChapterId = progress?.chapter_id ?? firstChapter?.id;
  const playHref = resumeChapterId ? `/player?book=${book.id}&chapter=${resumeChapterId}` : "";
  const percent = progress ? Math.round(progress.percent) : null;

  // The chapter picker follows the saved position until the user picks another.
  const selectedChapterId = chapterId ?? resumeChapterId ?? "";
  const selectedIndex = included.findIndex((chapter) => chapter.id === selectedChapterId);
  function goToChapter(nextId: string) {
    setChapterId(nextId);
    navigate(`/player?book=${book.id}&chapter=${nextId}`);
  }

  const chapterRow = (chapter: Chapter) => (
    <li key={chapter.id} className="flex min-h-11 items-center gap-3 px-4 py-1">
      <span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
        <span className="tabular-nums text-muted">{chapter.idx + 1}</span>
        <span className="truncate">{chapter.title}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{chapter.char_count.toLocaleString()} chars</span>
      <ChapterSwitch checked={!chapter.excluded} label={`Include ${chapter.title} in playback`} onToggle={() => toggleChapter(chapter)} />
    </li>
  );

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="relative w-40 shrink-0 self-start md:w-56">
        <BookCover book={book} className="aspect-[2/3] w-full rounded-card" />
        {notPlayable ? (
          <button
            type="button"
            disabled
            aria-label="Play"
            className="absolute inset-0 grid place-items-center"
          >
            <span className="grid h-14 w-14 place-items-center rounded-pill bg-brand-gradient text-white opacity-50">
              <Play size={24} strokeWidth={1.75} aria-hidden />
            </span>
          </button>
        ) : (
          <Link to={playHref} aria-label="Play" className="absolute inset-0 grid place-items-center">
            <span className="grid h-14 w-14 place-items-center rounded-pill bg-brand-gradient text-white shadow-lg transition-transform active:scale-95">
              <Play size={24} strokeWidth={1.75} aria-hidden />
            </span>
          </Link>
        )}
        {percent != null && (
          <span className="absolute bottom-2 left-2 rounded-pill bg-page/90 px-2 py-0.5 text-xs font-medium tabular-nums">
            {percent}%
          </span>
        )}
      </div>

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

        {included.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              aria-label="Chapters"
              value={selectedChapterId}
              onChange={(event) => goToChapter(event.target.value)}
              className="min-h-11 min-w-0 flex-1 rounded-card border border-line bg-card px-3 text-sm"
            >
              {included.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.idx + 1} · {chapter.title} · {chapter.char_count.toLocaleString()} chars
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Previous chapter"
              disabled={selectedIndex <= 0}
              onClick={() => {
                const prev = included[selectedIndex - 1];
                if (prev) goToChapter(prev.id);
              }}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-line bg-card disabled:opacity-40"
            >
              <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next chapter"
              disabled={selectedIndex < 0 || selectedIndex >= included.length - 1}
              onClick={() => {
                const next = included[selectedIndex + 1];
                if (next) goToChapter(next.id);
              }}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-line bg-card disabled:opacity-40"
            >
              <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
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

        {/* Quiet actions row: Edit + Find metadata inline, everything else in a
            more menu. The server enforces uploader-or-admin; a 403 surfaces inline. */}
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Link
              to={`/books/${id}/edit`}
              className="inline-flex min-h-11 items-center rounded-pill border border-line bg-card px-4 text-sm font-medium"
            >
              Edit
            </Link>
          )}
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
          <div className="relative ml-auto">
            <button
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="grid h-11 w-11 place-items-center rounded-pill border border-line bg-card text-ink"
            >
              <Ellipsis size={20} strokeWidth={1.75} aria-hidden />
            </button>
            {menuOpen && (
              <>
                <button type="button" tabIndex={-1} aria-hidden className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} />
                <div role="menu" aria-label="Book actions" className="absolute right-0 z-20 mt-1 w-52 rounded-card border border-line bg-card p-1 shadow-lg">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={toggleFinished.isPending}
                    onClick={() => {
                      toggleFinished.mutate(!finished);
                      setMenuOpen(false);
                    }}
                    className="flex min-h-11 w-full items-center rounded-card px-3 text-left text-sm hover:bg-page disabled:opacity-50"
                  >
                    {finished ? "Mark unfinished" : "Mark finished"}
                  </button>
                  {progress && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setResetOpen(true);
                      }}
                      className="flex min-h-11 w-full items-center rounded-card px-3 text-left text-sm hover:bg-page"
                    >
                      Reset progress
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={reprocess.isPending}
                        onClick={() => {
                          reprocess.mutate(undefined, {
                            onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", id] }),
                          });
                          setMenuOpen(false);
                        }}
                        className="flex min-h-11 w-full items-center rounded-card px-3 text-left text-sm hover:bg-page disabled:opacity-50"
                      >
                        Reprocess
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={remove.isPending}
                        onClick={() => {
                          setMenuOpen(false);
                          if (window.confirm(`Delete “${book.title}” from the library?`)) {
                            remove.mutate(undefined, {
                              onSuccess: () => {
                                queryClient.invalidateQueries({ queryKey: ["books"] });
                                navigate("/");
                              },
                            });
                          }
                        }}
                        className="flex min-h-11 w-full items-center rounded-card px-3 text-left text-sm text-danger hover:bg-page disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
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

        {canManage && (
          <div className="rounded-card border border-line bg-card">
            <button
              type="button"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-left font-display font-semibold"
            >
              <span className="flex items-center gap-2">
                <BookOpen size={18} strokeWidth={1.75} aria-hidden />
                Book settings
              </span>
              <ChevronDown size={18} strokeWidth={1.75} aria-hidden className={clsx("transition-transform", settingsOpen && "rotate-180")} />
            </button>
            {settingsOpen && (
              <div className="flex flex-col gap-4 border-t border-line px-4 py-4">
                <div className="flex flex-col gap-1">
                  <h3 className="font-display font-semibold">Chapters</h3>
                  <ol className="divide-y divide-line rounded-card border border-line">
                    {included.map((chapter) => chapterRow(chapter))}
                  </ol>
                  {setChapter.isError && (
                    <p role="alert" className="text-sm text-danger">
                      {setChapter.error.message}
                    </p>
                  )}
                  {excludedChapters.length > 0 && (
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        type="button"
                        aria-expanded={excludedOpen}
                        onClick={() => setExcludedOpen((open) => !open)}
                        className="flex min-h-11 items-center justify-between gap-2 rounded-card border border-line px-4 text-left text-sm font-medium text-muted"
                      >
                        <span>Excluded ({excludedChapters.length})</span>
                        <ChevronDown
                          size={18}
                          strokeWidth={1.75}
                          aria-hidden
                          className={clsx("transition-transform", excludedOpen && "rotate-180")}
                        />
                      </button>
                      {excludedOpen && (
                        <ol className="divide-y divide-line rounded-card border border-line">
                          {excludedChapters.map((chapter) => chapterRow(chapter))}
                        </ol>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <h3 className="font-display font-semibold">Pronunciation rules</h3>
                  <PronunciationRules bookId={id} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {resetOpen && (
        <div className="fixed inset-0 z-40 grid place-items-center p-4">
          <button type="button" tabIndex={-1} aria-hidden className="absolute inset-0 cursor-default bg-ink/50" onClick={() => setResetOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Reset listening progress" className="relative w-full max-w-sm rounded-card border border-line bg-card p-4">
            <p className="font-display font-semibold">Reset listening progress?</p>
            <p className="mt-1 text-sm text-muted">This cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setResetOpen(false)}
                className="min-h-11 flex-1 rounded-pill border border-line bg-page px-4 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={reset.isPending}
                onClick={() =>
                  reset.mutate(undefined, {
                    onSuccess: () => {
                      localStorage.removeItem(`folio-pos-${id}`);
                      invalidateProgress();
                      setResetOpen(false);
                      navigate(firstChapter ? `/player?book=${book.id}&chapter=${firstChapter.id}` : `/player?book=${book.id}`);
                    },
                  })
                }
                className="min-h-11 flex-1 rounded-pill bg-brand-gradient px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
