/** Phase 4 book page (handoff "Book page"): hero with cover progress badge,
 * one gradient primary action (Play / Resume / Playing now), the ⋯ listener
 * menu with undo toast, and Chapters / About / Manage tabs. Playback itself
 * lives in the Now Playing surfaces; this page only drives the shared player
 * state. Breakpoint-dependent fragments (meta line, chapter row cells, the
 * ⋯ trigger) render one variant at a time via `useIsDesktop` so the DOM and
 * the accessibility tree match the visible layout. */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useBook, useDeleteBook, useReprocessBook, useSetChapterExcluded } from "../api/books";
import { api } from "../api/client";
import { useMetadataCandidates, useUpdateBook } from "../api/metadata";
import { fetchSegments } from "../api/audio";
import {
  continueQueryKey,
  deviceLabel,
  markFinished,
  progressQueryKey,
  resetProgress,
  useBookProgress,
} from "../api/progress";
import { useListeningSettings } from "../api/settings";
import { useAuth } from "../auth/AuthProvider";
import { BookCover } from "../components/BookCard";
import { BookMenu } from "../components/BookMenu";
import { CoverProgressBadge } from "../components/CoverProgressBadge";
import { EmptyState } from "../components/EmptyState";
import { FindMetadata } from "../components/FindMetadata";
import { Icon } from "../components/Icon";
import { PronunciationRules } from "../components/PronunciationRules";
import { StatusBadge } from "../components/StatusBadge";
import { VoicePicker } from "../components/VoicePicker";
import { formatTime } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import type { BookDetailResponse, Candidate, Chapter } from "../api/types";

const DESKTOP_QUERY = "(min-width: 1050px)"; // the `desktop:` breakpoint in tokens.css

function useIsDesktop(): boolean {
  const [is, setIs] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIs(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return is;
}

/** "4 h 12 m" / "36 m" for meta and time-left lines. */
function formatLength(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso));
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split("-")[0]!) ?? code;
  } catch {
    return code;
  }
}

const TABS = ["Chapters", "About", "Manage"] as const;
type Tab = (typeof TABS)[number];

/** roving-tabindex tablist: arrows / Home / End move selection and focus. */
function TabList({ tabs, active, onSelect }: { tabs: readonly Tab[]; active: Tab; onSelect: (tab: Tab) => void }) {
  const refs = useRef(new Map<Tab, HTMLButtonElement>());
  function onKeyDown(event: ReactKeyboardEvent, index: number) {
    const last = tabs.length - 1;
    let next = -1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    const name = tabs[next]!;
    onSelect(name);
    refs.current.get(name)?.focus();
  }
  return (
    <div role="tablist" aria-label="Book sections" className="flex gap-5 border-b border-divider">
      {tabs.map((tab, index) => (
        <button
          key={tab}
          ref={(node) => {
            if (node) refs.current.set(tab, node);
            else refs.current.delete(tab);
          }}
          type="button"
          role="tab"
          id={`book-tab-${tab}`}
          aria-selected={active === tab}
          aria-controls="book-panel"
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onSelect(tab)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={clsx(
            "tap border-b-2 text-base",
            active === tab ? "border-fg font-semibold text-fg" : "border-transparent font-medium text-fg-2",
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 cursor-default bg-fg/50"
        onClick={onCancel}
      />
      <div role="dialog" aria-modal="true" aria-label={title} className="relative w-full max-w-sm rounded-lg border border-divider bg-surface p-4">
        <p className="font-display font-semibold">{title}</p>
        <p className="mt-1 text-sm text-fg-2">{description}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCancel} className="tap min-h-11 flex-1 rounded-md border border-control-border bg-surface px-4 text-base font-medium">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={clsx(
              "tap min-h-11 flex-1 rounded-md px-4 text-base font-semibold disabled:opacity-50",
              danger ? "border border-danger text-danger" : "bg-primary-gradient text-on-primary",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ManageCard({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-divider bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md font-semibold">{title}</h2>
        {aside && <span className="text-xs tabular text-fg-2">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const outlineButton =
  "tap inline-flex h-9 items-center gap-1.5 rounded-md border border-control-border bg-surface px-3 text-base font-medium hover:bg-raised disabled:opacity-50";

const STATUS_LABELS: Record<string, string> = {
  uploading: "Uploading",
  processing: "Processing…",
  ready: "Ready",
  needs_ocr: "Needs OCR",
  failed: "Failed",
};

export function BookDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const player = usePlayer();
  const desktop = useIsDesktop();
  const { data, isPending, error } = useBook(id);
  const progressQuery = useBookProgress(id);
  const { settings } = useListeningSettings();
  const reprocess = useReprocessBook(id);
  const remove = useDeleteBook(id);
  const update = useUpdateBook(id);
  const candidates = useMetadataCandidates(id);

  const [tab, setTab] = useState<Tab>("Chapters");
  const [findOpen, setFindOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<Candidate[] | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [showAllChapters, setShowAllChapters] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: boolean } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function invalidateProgress() {
    queryClient.invalidateQueries({ queryKey: ["book", id] });
    queryClient.invalidateQueries({ queryKey: progressQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: continueQueryKey });
  }

  const toggleFinished = useMutation({
    mutationFn: async (value: boolean) => {
      if (value && !progress) {
        // The finished toggle updates an existing row and 404s without one,
        // so create the row at the first segment first (docs/DECISIONS.md).
        const first = included[0];
        if (!first) throw new Error("This book has no chapters yet.");
        const [segment] = await fetchSegments(id, first.id);
        if (!segment) throw new Error("This book has no chapters yet.");
        await api.put(`/books/${id}/progress`, {
          chapter_id: first.id,
          segment_id: segment.id,
          offset_s: 0,
          device_label: deviceLabel(),
        });
      }
      return markFinished(id, value);
    },
    onSuccess: (_result, value) => {
      invalidateProgress();
      setToast(value ? { message: "Marked as finished", undo: true } : null);
    },
    onError: () => setToast({ message: "Couldn’t update this book. Try again." }),
  });

  const reset = useMutation({ mutationFn: () => resetProgress(id) });

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
    setChapter.mutate({ chapterId: chapter.id, excluded }, { onError: () => write(!excluded) });
  }

  if (error instanceof Error) {
    return (
      <EmptyState
        icon={<Icon name="error" size={28} />}
        title="Book not found"
        description={error.message}
        action={
          <Link to="/" className="text-sm font-medium text-accent-fg underline">
            Back to library
          </Link>
        }
      />
    );
  }

  if (isPending || !data) {
    return (
      <div className="animate-pulse" aria-busy="true">
        <div className="flex gap-4">
          <div className="h-24 w-16 rounded-cover bg-raised desktop:h-[180px] desktop:w-[120px]" />
          <div className="flex-1 space-y-3">
            <div className="h-8 w-2/3 rounded bg-raised" />
            <div className="h-4 w-1/2 rounded bg-raised" />
            <div className="h-24 rounded-lg bg-raised" />
          </div>
        </div>
      </div>
    );
  }

  const { book } = data;
  const included = data.chapters.filter((chapter) => !chapter.excluded);
  const saved = candidates.data?.items ?? [];
  const progress = progressQuery.data ?? data.progress;
  const finished = Boolean(progress?.finished_at);
  const percent = progress ? Math.round(progress.percent) : null;
  // can_edit is server-computed (admin or uploader, plan M6 A4); payloads
  // predating it fall back to admin-only. The server enforces either way.
  const canManage = book.can_edit ?? user?.role === "admin";
  const tabs = canManage ? TABS : (TABS.filter((name) => name !== "Manage") as readonly Tab[]);
  const firstChapter = included[0];
  const notPlayable = book.status === "needs_ocr" || book.status === "failed" || !firstChapter;
  const loadedHere = player.book?.id === id;
  const playingHere = loadedHere && player.playing;
  const voice = book.narrator_voice ?? settings.voices[book.language] ?? null;
  const secondsPerChar = book.total_chars > 0 && book.est_duration_s ? book.est_duration_s / book.total_chars : 1 / 15;
  const chapterSeconds = (chapter: Chapter) => chapter.char_count * secondsPerChar;
  const length = book.est_duration_s ? formatLength(book.est_duration_s) : null;
  const series = book.series ? `${book.series}${book.series_index != null ? ` #${book.series_index}` : ""}` : null;
  const progressChapter = progress ? data.chapters.find((chapter) => chapter.id === progress.chapter_id) ?? null : null;
  const currentIndex = loadedHere ? player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id) : -1;
  const currentId = loadedHere ? player.chapter?.id ?? null : progressChapter?.id ?? null;

  /** "played" is approximate: chapters before the progress (or live player)
   * chapter count as played; a finished book is all played (DECISIONS). */
  function chapterState(chapter: Chapter): "played" | "current" | null {
    if (finished) return "played";
    if (chapter.id === currentId) return "current";
    if (currentIndex >= 0 && player.chapters[currentIndex]) return chapter.idx < player.chapters[currentIndex]!.idx ? "played" : null;
    if (progressChapter) return chapter.idx < progressChapter.idx ? "played" : null;
    return null;
  }

  function chapterPercent(chapter: Chapter): number | null {
    if (loadedHere && chapter.id === player.chapter?.id) {
      return player.chapterTotal > 0 ? Math.round((player.chapterElapsed / player.chapterTotal) * 100) : null;
    }
    if (!progress || chapter.id !== progressChapter?.id || chapter.char_count === 0) return null;
    const before = included.filter((other) => other.idx < chapter.idx).reduce((sum, other) => sum + other.char_count, 0);
    const into = (progress.percent / 100) * book.total_chars - before;
    return Math.min(100, Math.max(0, Math.round((into / chapter.char_count) * 100)));
  }

  async function playFrom(chapterId?: string) {
    if (player.book?.id !== id) await player.load(id, chapterId);
    if (chapterId) await player.goToChapter(chapterId);
    await player.play();
  }

  async function restartFromStart(chapterId: string) {
    if (player.book?.id === id) await player.goToChapter(chapterId);
    else await player.load(id, chapterId);
    player.seekChapter(0);
    await player.play();
  }

  /** "Playing now" focuses the panel (desktop) or expands the sheet (phone). */
  function focusPlayerSurface() {
    if (!desktop) {
      navigate(`/player?book=${id}`);
      return;
    }
    const panel = document.querySelector<HTMLElement>('aside[aria-label="Now playing"]');
    if (panel && !panel.matches("[inert]")) {
      panel.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    document.querySelector<HTMLElement>('section[aria-label="Now playing"] button')?.focus();
  }

  const actionLabel = notPlayable ? "Play" : playingHere ? "Playing now" : progress || loadedHere ? "Resume" : "Play";
  const coverLabel = finished
    ? `${book.title}, finished`
    : percent != null
      ? `${book.title}, ${percent}% listened`
      : book.title;
  const metaLine = desktop
    ? [languageName(book.language), length, `${included.length} chapters`, voice && `narrated by ${voice}`]
    : [length, `${included.length} chapters`];
  const progressLine = finished
    ? "Finished"
    : desktop
      ? `${percent}% · ${formatLength((book.est_duration_s ?? 0) * (1 - (progress?.percent ?? 0) / 100))} left`
      : `Ch. ${(progressChapter?.idx ?? 0) + 1} · ${percent}%`;

  const chapterRowCells = (chapter: Chapter) => {
    const state = chapterState(chapter);
    const current = state === "current";
    const seconds = chapterSeconds(chapter);
    const lengthText = desktop ? formatTime(seconds) : `${Math.max(1, Math.round(seconds / 60))} m`;
    const rowPercent = current ? chapterPercent(chapter) : null;
    return (
      <>
        <span className={clsx("tabular text-sm", current ? "font-semibold text-on-selected" : "text-fg-2")}>{chapter.idx + 1}</span>
        <span className={clsx("min-w-0 truncate", current ? "font-semibold text-fg" : state === "played" ? "text-fg-2" : "text-fg")}>
          {chapter.title}
        </span>
        <span
          className={clsx(
            "truncate text-right tabular text-xs desktop:text-sm",
            state ? "hidden desktop:block" : "",
            current ? "text-fg" : "text-fg-2",
          )}
        >
          {lengthText}
        </span>
        <span className={clsx("items-center justify-end", state ? "flex" : "hidden desktop:flex")}>
          {state === "played" && (
            <>
              <Icon name="check" size={desktop ? 18 : 20} className="text-fg-2" />
              <span className="sr-only">Played</span>
            </>
          )}
          {current && desktop && rowPercent != null && <span className="text-sm tabular text-on-selected">{rowPercent}%</span>}
          {current && !desktop && playingHere && <span className="text-xs text-on-selected">Playing</span>}
        </span>
      </>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5">
      {!desktop && (
        <div className="fixed top-[calc(env(safe-area-inset-top)+0.125rem)] right-2 z-30">
          <BookMenu
            finished={finished}
            pending={toggleFinished.isPending}
            onToggleFinished={(value) => toggleFinished.mutate(value)}
            onReset={() => setResetOpen(true)}
            variant="header"
          />
        </div>
      )}

      <Link
        to="/"
        className={clsx("items-center gap-1 self-start text-sm text-fg-2 hover:text-fg", desktop ? "inline-flex min-h-8" : "hidden")}
      >
        <Icon name="chevron_left" size={20} /> Library
      </Link>

      {saved.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-divider bg-surface px-3 py-2">
          <p className="text-sm text-fg-2">Online matches were found but not applied automatically.</p>
          <button
            type="button"
            onClick={() => {
              setReviewItems(saved);
              setFindOpen(true);
            }}
            className={outlineButton}
          >
            Review metadata matches
          </button>
        </div>
      )}
      {findOpen && tab !== "Manage" && <FindMetadata book={book} initialItems={reviewItems ?? undefined} />}

      {book.status === "failed" && book.error && (
        <p role="alert" className="rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger">
          {book.error}
        </p>
      )}

      <section className={clsx("flex flex-col gap-3", !desktop && "rounded-lg border border-divider bg-surface p-3")}>
        <div className="flex items-end gap-3 desktop:gap-5">
          <span
            role="img"
            aria-label={coverLabel}
            className={clsx(
              "relative shrink-0 overflow-hidden rounded-cover shadow-(--shadow-cover)",
              desktop ? "h-[180px] w-[120px]" : "h-24 w-16",
            )}
          >
            <BookCover book={book} className="h-full w-full" />
            <CoverProgressBadge percent={percent} finished={finished} />
          </span>
          <div className="flex min-w-0 flex-col gap-1" lang={book.language}>
            <h1 className={clsx("font-display font-bold tracking-[-0.01em]", desktop ? "text-xl leading-[1.2]" : "text-lg leading-[1.25]")}>
              {book.title}
            </h1>
            <p className={clsx("min-w-0 truncate text-fg-2", desktop ? "text-md" : "text-sm")}>{book.authors.join(", ")}</p>
            <p className={clsx("text-fg-2", desktop ? "text-sm" : "text-xs")}>{metaLine.filter(Boolean).join(" · ")}</p>
            {book.status !== "ready" && (
              <div className="pt-1">
                <StatusBadge status={book.status} />
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col-reverse gap-3 desktop:flex-col">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={notPlayable}
              onClick={playingHere ? focusPlayerSurface : () => void playFrom(progress?.chapter_id ?? firstChapter?.id)}
              className={clsx(
                "tap inline-flex items-center justify-center gap-2 rounded-md font-semibold disabled:opacity-50",
                desktop ? "h-9 px-3.5 text-base" : "h-11 flex-1 px-4 text-[16px] font-bold",
                playingHere ? "bg-selected text-on-selected" : "bg-primary-gradient text-on-primary",
              )}
            >
              <Icon name={playingHere ? "headphones" : "play_arrow"} size={desktop ? 20 : 22} />
              {actionLabel}
            </button>
            <button
              type="button"
              aria-label={`Narrator voice: ${voice ?? "default"}`}
              title="Narrator voice"
              aria-expanded={voiceOpen}
              onClick={() => setVoiceOpen((open) => !open)}
              className="tap grid size-11 shrink-0 place-items-center rounded-md text-fg hover:bg-raised desktop:size-9"
            >
              <Icon name="record_voice_over" size={desktop ? 20 : 22} />
            </button>
            {desktop && (
              <BookMenu
                finished={finished}
                pending={toggleFinished.isPending}
                onToggleFinished={(value) => toggleFinished.mutate(value)}
                onReset={() => setResetOpen(true)}
              />
            )}
          </div>
          {progress != null && (
            <div className="flex items-center gap-2.5 text-xs tabular text-fg-2">
              <div className={clsx("h-1 rounded-xs bg-track", desktop ? "max-w-[320px] flex-1" : "flex-1")}>
                <div className="h-full rounded-xs bg-progress" style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
              </div>
              <span className="whitespace-nowrap">{progressLine}</span>
            </div>
          )}
        </div>
        {voiceOpen && (
          <div className="flex flex-col gap-1 border-t border-divider pt-3">
            <h2 className="text-sm font-semibold">Narrator voice</h2>
            <VoicePicker
              value={book.narrator_voice}
              language={book.language}
              onChange={(next) => update.mutate({ narrator_voice: next })}
            />
            {update.isError && (
              <p role="alert" className="text-sm text-danger">
                {update.error.message}
              </p>
            )}
          </div>
        )}
      </section>

      <div className="flex flex-col gap-3">
        <TabList tabs={tabs} active={tab} onSelect={setTab} />
        <div role="tabpanel" id="book-panel" aria-labelledby={`book-tab-${tab}`} tabIndex={-1}>
          {tab === "Chapters" &&
            (data.chapters.length === 0 ? (
              <p className="py-4 text-sm text-fg-2">No chapters yet. Processing will build them.</p>
            ) : (
              <ol className="flex flex-col gap-0.5 pt-2">
                {data.chapters.map((chapter) => {
                  const state = chapterState(chapter);
                  const rowClass = clsx(
                    "tap grid w-full items-center gap-2.5 rounded-md px-2.5 text-left text-base",
                    desktop
                      ? "min-h-9 grid-cols-[32px_minmax(0,1fr)_4rem_3rem]"
                      : "min-h-11 grid-cols-[20px_minmax(0,1fr)_auto]",
                  );
                  return (
                    <li key={chapter.id}>
                      {chapter.excluded ? (
                        <div className={clsx(rowClass, "opacity-60")} aria-disabled="true" title="Excluded from narration">
                          {chapterRowCells(chapter)}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void playFrom(chapter.id)}
                          aria-current={state === "current" ? "true" : undefined}
                          className={clsx(rowClass, state === "current" && desktop && "border border-divider bg-surface")}
                        >
                          {chapterRowCells(chapter)}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            ))}

          {tab === "About" && (
            <div className="flex max-w-[640px] flex-col gap-5 pt-4" lang={book.language}>
              {book.description && (
                <div className="font-reading text-[16px] whitespace-pre-line leading-[1.6] text-reading">{book.description}</div>
              )}
              <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2.5">
                {book.authors.length > 0 && (
                  <>
                    <dt className="text-sm text-fg-2">Author</dt>
                    <dd className="text-base">
                      {book.authors.map((author, index) => (
                        <span key={author}>
                          {index > 0 && ", "}
                          <Link to={`/?q=${encodeURIComponent(author)}`} className="text-accent-fg hover:text-fg">
                            {author}
                          </Link>
                        </span>
                      ))}
                    </dd>
                  </>
                )}
                {series && (
                  <>
                    <dt className="text-sm text-fg-2">Series</dt>
                    <dd className="text-base">{series}</dd>
                  </>
                )}
                {book.publisher && (
                  <>
                    <dt className="text-sm text-fg-2">Publisher</dt>
                    <dd className="text-base">{book.publisher}</dd>
                  </>
                )}
                {book.published_date && (
                  <>
                    <dt className="text-sm text-fg-2">Published</dt>
                    <dd className="text-base">
                      {/* A bare year stays as written; a real date/timestamp is formatted. */}
                      {/^\d{4}-\d{2}/.test(book.published_date) && !Number.isNaN(Date.parse(book.published_date))
                        ? formatDate(book.published_date)
                        : book.published_date}
                    </dd>
                  </>
                )}
                <dt className="text-sm text-fg-2">Language</dt>
                <dd className="text-base">{languageName(book.language)}</dd>
                {(length || data.chapters.length > 0) && (
                  <>
                    <dt className="text-sm text-fg-2">Length</dt>
                    <dd className="text-base">{[length && `About ${length}`, `${included.length} chapters`].filter(Boolean).join(" · ")}</dd>
                  </>
                )}
                {voice && (
                  <>
                    <dt className="text-sm text-fg-2">Narrator</dt>
                    <dd className="text-base">{voice}</dd>
                  </>
                )}
                {(book.isbn13 ?? book.isbn10) && (
                  <>
                    <dt className="text-sm text-fg-2">ISBN</dt>
                    <dd className="text-base">{book.isbn13 ?? book.isbn10}</dd>
                  </>
                )}
                <dt className="text-sm text-fg-2">Added</dt>
                <dd className="text-base">{formatDate(book.created_at)}</dd>
              </dl>
              {book.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {book.tags.map((tag) => (
                    <Link
                      key={tag}
                      to={`/?q=${encodeURIComponent(tag)}`}
                      className="inline-flex h-7 items-center rounded-md bg-raised px-2.5 text-sm text-fg hover:bg-divider"
                    >
                      {tag}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "Manage" && canManage && (
            <div className="flex max-w-[680px] flex-col gap-3 pt-4">
              <ManageCard title="Details">
                <p className="text-sm text-fg-2">Fields you edited by hand are protected from automatic updates.</p>
                <div className="flex flex-wrap gap-2">
                  <Link to={`/books/${id}/edit`} className={outlineButton}>
                    Edit details
                  </Link>
                  <button
                    type="button"
                    aria-expanded={findOpen}
                    onClick={() => {
                      setReviewItems(null);
                      setFindOpen((open) => !open);
                    }}
                    className={outlineButton}
                  >
                    Find metadata
                  </button>
                </div>
                {findOpen && <FindMetadata book={book} initialItems={reviewItems ?? undefined} />}
              </ManageCard>

              <ManageCard title="Chapters to narrate" aside={`${included.length} of ${data.chapters.length} included`}>
                <p className="text-sm text-fg-2">Skip front and back matter you don’t want read aloud.</p>
                <div className="flex flex-col">
                  {(showAllChapters ? data.chapters : data.chapters.slice(0, 5)).map((chapter) => (
                    <label key={chapter.id} className="tap flex items-center gap-2.5 text-base">
                      <input
                        type="checkbox"
                        checked={!chapter.excluded}
                        onChange={() => toggleChapter(chapter)}
                        className="size-4 shrink-0 accent-progress"
                      />
                      <span className={clsx("min-w-0 flex-1 truncate", chapter.excluded ? "text-fg-2" : "text-fg")}>
                        {chapter.idx + 1} · {chapter.title}
                      </span>
                      <span className="text-xs tabular text-fg-2">{formatTime(chapterSeconds(chapter))}</span>
                    </label>
                  ))}
                </div>
                {setChapter.isError && (
                  <p role="alert" className="text-sm text-danger">
                    {setChapter.error.message}
                  </p>
                )}
                {data.chapters.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllChapters((value) => !value)}
                    className="self-start py-1.5 text-sm text-accent-fg hover:text-fg"
                  >
                    {showAllChapters ? "Show less" : `Show all ${data.chapters.length}`}
                  </button>
                )}
              </ManageCard>

              <ManageCard title="Pronunciation">
                <p className="text-sm text-fg-2">Tell the narrator how to say names and words in this book.</p>
                <PronunciationRules bookId={id} />
              </ManageCard>

              <ManageCard title="Processing">
                <p className="flex items-center gap-2 text-base">
                  {book.status === "ready" && <Icon name="check" size={18} className="text-success" />}
                  {book.status === "failed" && <Icon name="error" size={18} className="text-danger" />}
                  <span>
                    {[STATUS_LABELS[book.status] ?? book.status, `${data.chapters.length} chapters`, `processed ${formatDate(book.updated_at)}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </p>
                <p className="text-sm text-fg-2">
                  Reprocessing rebuilds chapters from the original file and clears this book’s generated audio. Everyone’s
                  progress is kept.
                </p>
                <div>
                  <button
                    type="button"
                    disabled={reprocess.isPending}
                    onClick={() =>
                      reprocess.mutate(undefined, {
                        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", id] }),
                      })
                    }
                    className={outlineButton}
                  >
                    Reprocess book
                  </button>
                </div>
                {reprocess.isError && (
                  <p role="alert" className="text-sm text-danger">
                    {reprocess.error.message}
                  </p>
                )}
              </ManageCard>

              <section className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-danger p-4">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h2 className="text-md font-semibold">Delete book</h2>
                  <p className="text-sm text-fg-2">Removes the book, its generated audio and every listener’s progress. This can’t be undone.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  className="tap inline-flex h-9 items-center rounded-md border border-danger px-3 text-base font-semibold text-danger hover:bg-raised"
                >
                  Delete book
                </button>
              </section>
            </div>
          )}
        </div>
      </div>

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-4 desktop:bottom-8">
        {toast && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-divider bg-surface px-3 py-2 text-sm shadow-(--shadow-menu)">
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  setToast(null);
                  toggleFinished.mutate(false);
                }}
                className="font-semibold text-accent-fg"
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      {resetOpen && (
        <ConfirmDialog
          title="Reset listening progress"
          description="This cannot be undone."
          confirmLabel="Reset"
          busy={reset.isPending}
          onCancel={() => setResetOpen(false)}
          onConfirm={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                localStorage.removeItem(`folio-pos-${id}`);
                invalidateProgress();
                setResetOpen(false);
                if (firstChapter) void restartFromStart(firstChapter.id);
              },
            })
          }
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={`Delete “${book.title}”?`}
          description="Removes the book, its generated audio and every listener’s progress. This can’t be undone."
          confirmLabel="Delete"
          danger
          busy={remove.isPending}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: ["books"] });
                navigate("/");
              },
            })
          }
        />
      )}
    </div>
  );
}
