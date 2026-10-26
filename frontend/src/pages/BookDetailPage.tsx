/** Direction D book page (handoff "Book page"): two columns — a ≤340px cover
 * column (cover with accent progress bar, title, author link, meta, clamped
 * description, progress line, white primary pill + outlined ⋮) and pill tabs
 * on the right (Chapters / About / Manage). Under 768px it becomes one
 * centered column with a back + ⋮ header. The ⋮ menu is the only place a
 * book's narrator is chosen. Playback drives the shared player state only. */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useMatch, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { languageName, useBook, useDeleteBook, useReprocessBook, useSetChapterExcluded } from "../api/books";
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
import { baseLanguage, voiceLabel } from "../api/voices";
import { useAuth } from "../auth/AuthProvider";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { BookCover } from "../components/BookCard";
import { BookMenu } from "../components/BookMenu";
import { ChapterRow } from "../components/ChapterRow";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CoverProgressBadge } from "../components/CoverProgressBadge";
import { EditDetailsDrawer } from "../components/EditDetailsDrawer";
import { EmptyState } from "../components/EmptyState";
import { FindMetadata } from "../components/FindMetadata";
import { Icon } from "../components/Icon";
import { NarratorVoiceDialog } from "../components/NarratorVoiceDialog";
import { PronunciationRules } from "../components/PronunciationRules";
import { StatusBadge } from "../components/StatusBadge";
import { Switch } from "../components/Switch";
import { formatTime } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import type { Candidate, Chapter } from "../api/types";

/** "4 h 12 m" / "36 m" for meta and time-left lines. */
function formatLength(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso));
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
    <div role="tablist" aria-label="Book sections" className="flex flex-wrap gap-2">
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
            "tap h-[34px] rounded-full px-3.5 text-base",
            active === tab ? "bg-fg font-bold text-on-fg" : "bg-raised font-medium text-fg hover:bg-border",
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

/** Settings-style Manage row: title + explanation left, controls right. */
function ManageRow({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 basis-[260px] flex-1 flex-col gap-1">
        <span className="text-lg font-bold">{title}</span>
        <span className="text-base leading-[1.45] text-fg-2">{description}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const outlinePill =
  "tap inline-flex h-10 items-center gap-2 rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg no-underline hover:bg-raised disabled:opacity-50";

const STATUS_LABELS: Record<string, string> = {
  uploading: "Uploading",
  processing: "Processing…",
  ready: "Ready",
  needs_ocr: "Needs OCR",
  failed: "Failed",
};

export function BookDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  // /books/:id/edit renders this page with the Edit details drawer on top.
  const editing = useMatch("/books/:id/edit") !== null;
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const player = usePlayer();
  // Mobile-first: without matchMedia (old browsers, jsdom) render the phone layout.
  const phone = !useMediaQuery("(min-width: 768px)", false);
  const { data, isPending, error } = useBook(id);
  const progressQuery = useBookProgress(id);
  const { settings } = useListeningSettings();
  const reprocess = useReprocessBook(id);
  const remove = useDeleteBook(id);
  const update = useUpdateBook(id);
  const candidates = useMetadataCandidates(id);

  const [tab, setTab] = useState<Tab>(() =>
    (location.state as { tab?: Tab } | null)?.tab === "Manage" ? "Manage" : "Chapters",
  );
  const [findOpen, setFindOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<Candidate[] | null>(null);
  const [pendingChapterId, setPendingChapterId] = useState<string | null>(null);
  const [showAllChapters, setShowAllChapters] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [narratorOpen, setNarratorOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo?: boolean } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Clear the "Preparing…" state once the requested chapter is really
  // playing, once the player reports an error, or after the safety timeout.
  useEffect(() => {
    if (!pendingChapterId) return;
    if (player.error || (player.playing && player.chapter?.id === pendingChapterId)) {
      setPendingChapterId(null);
      return;
    }
    const timer = window.setTimeout(() => setPendingChapterId(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [pendingChapterId, player.error, player.playing, player.chapter]);

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

  // Optimistic exclude/include lives in useSetChapterExcluded; the cache stays
  // authoritative for the session because the server may omit excluded
  // chapters from GET /books/{id}.
  const setChapter = useSetChapterExcluded(id);
  function toggleChapter(chapter: Chapter) {
    setChapter.mutate({ chapterId: chapter.id, excluded: !chapter.excluded });
  }

  if (error instanceof Error) {
    return (
      <EmptyState
        icon={<Icon name="TriangleAlert" size={28} />}
        title="Book not found"
        description={error.message}
        action={
          <Link to="/library" className="text-base font-semibold text-fg underline">
            Back to library
          </Link>
        }
      />
    );
  }

  if (isPending || !data) {
    return (
      <div className="animate-pulse" aria-busy="true">
        <div className="grid grid-cols-1 items-start gap-12 pt-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="aspect-[2/3] w-full max-w-[300px] rounded-lg bg-raised" />
            <div className="h-9 w-2/3 rounded bg-raised" />
            <div className="h-4 w-1/2 rounded bg-raised" />
          </div>
          <div className="min-w-0 space-y-2 pt-10">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-12 rounded-lg bg-raised" />
            ))}
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
  // The edit route always shows the Manage tab underneath the drawer.
  const activeTab: Tab = editing && canManage ? "Manage" : tab;
  const firstChapter = included[0];
  const notPlayable = book.status === "needs_ocr" || book.status === "failed" || !firstChapter;
  const loadedHere = player.book?.id === id;
  const playingHere = loadedHere && player.playing;
  const voice = book.narrator_voice ?? settings.voices[baseLanguage(book.language)] ?? null;
  const secondsPerChar = book.total_chars > 0 && book.est_duration_s ? book.est_duration_s / book.total_chars : 1 / 15;
  const chapterSeconds = (chapter: Chapter) => chapter.char_count * secondsPerChar;
  const length = book.est_duration_s ? formatLength(book.est_duration_s) : null;
  const series = book.series ? `${book.series}${book.series_index != null ? ` #${book.series_index}` : ""}` : null;
  const author = book.authors[0] ?? "";
  const authorHref = `/search?q=${encodeURIComponent(author)}`;
  const lockedCount = (book.locked_fields ?? []).length;
  // Resume candidates come from the included list only: a saved chapter that
  // was later excluded must not resume (the player starts at the beginning).
  const progressChapter = progress ? included.find((chapter) => chapter.id === progress.chapter_id) ?? null : null;
  const currentIndex = loadedHere ? player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id) : -1;
  const currentId = loadedHere ? player.chapter?.id ?? null : progressChapter?.id ?? null;
  const resumeChapter = loadedHere ? player.chapter : progressChapter;

  /** "played" is approximate: chapters before the progress (or live player)
   * chapter count as played; a finished book is all played (DECISIONS).
   * Positions come from the included list so excluded chapters neither leave
   * gaps in the numbering nor shift what counts as played. */
  function chapterState(chapter: Chapter): "played" | "current" | null {
    if (finished) return "played";
    if (chapter.id === currentId) return "current";
    const position = included.indexOf(chapter); // -1 for excluded chapters
    if (currentIndex >= 0) return position < currentIndex ? "played" : null;
    if (progressChapter) return position < included.indexOf(progressChapter) ? "played" : null;
    return null;
  }

  function chapterPercent(chapter: Chapter): number | null {
    // Live position when the player knows the chapter's audio duration;
    // otherwise the character-based position from the saved progress row.
    if (loadedHere && chapter.id === player.chapter?.id && player.chapterTotal > 0) {
      return Math.round((player.chapterElapsed / player.chapterTotal) * 100);
    }
    if (!progress || chapter.id !== progressChapter?.id || chapter.char_count === 0) return null;
    const before = included.filter((other) => other.idx < chapter.idx).reduce((sum, other) => sum + other.char_count, 0);
    const into = (progress.percent / 100) * book.total_chars - before;
    return Math.min(100, Math.max(0, Math.round((into / chapter.char_count) * 100)));
  }

  async function playFrom(chapterId?: string) {
    // The chapter that is about to start: the clicked one, else the loaded
    // one, else the saved (included) or first one. Only used for the pending
    // indicator; navigation below keeps its original semantics.
    const target = chapterId ?? resumeChapter?.id ?? firstChapter?.id ?? null;
    if (target) setPendingChapterId(target);
    if (player.book?.id !== id) await player.load(id, chapterId);
    if (chapterId) await player.goToChapter(chapterId);
    await player.play();
  }

  async function restartFromStart(chapterId: string) {
    if (player.book?.id !== id) await player.load(id, chapterId);
    // load() resumes the saved position, which for a finished book is the
    // last chapter: jump to the requested chapter, then rewind to 0.
    await player.goToChapter(chapterId);
    player.seekChapter(0);
    await player.play();
  }

  function primaryAction() {
    if (playingHere) {
      player.pause();
      return;
    }
    if (finished) {
      if (firstChapter) void restartFromStart(firstChapter.id);
      return;
    }
    void playFrom(resumeChapter?.id ?? firstChapter?.id);
  }

  const preparingHere = !playingHere && (player.preparing || pendingChapterId !== null);
  const actionLabel = notPlayable
    ? "Play"
    : playingHere
      ? "Pause"
      : preparingHere
        ? "Preparing…"
        : finished
          ? "Play again"
          : resumeChapter || loadedHere
            ? "Resume"
            : "Play";
  const coverLabel = finished
    ? `${book.title}, finished`
    : percent != null
      ? `${book.title}, ${percent}% listened`
      : book.title;
  const metaDesktop = ["Book", languageName(book.language), length, `${included.length} chapters`].filter(Boolean).join(" · ");
  const metaPhone = [
    length,
    `${included.length} chapters`,
    finished ? "finished" : percent != null ? `${percent}% listened` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const primaryButton = (fullWidth: boolean) => (
    <button
      type="button"
      disabled={notPlayable}
      onClick={primaryAction}
      className={clsx(
        "tap inline-flex h-12 items-center justify-center gap-2 rounded-full bg-fg px-[18px] text-lg font-bold text-on-fg disabled:opacity-50",
        fullWidth ? "w-full" : "whitespace-nowrap",
      )}
    >
      {preparingHere ? (
        <Icon name="RefreshCw" size={20} className="animate-spin" />
      ) : (
        <Icon name={playingHere ? "Pause" : "Play"} size={20} />
      )}
      {actionLabel}
    </button>
  );

  const bookMenu = (variant: "inline" | "header") => (
    <BookMenu
      variant={variant}
      finished={finished}
      pending={toggleFinished.isPending}
      onToggleFinished={(value) => toggleFinished.mutate(value)}
      onReset={() => setResetOpen(true)}
      onNarrator={() => setNarratorOpen(true)}
      onGoToAuthor={() => void navigate(authorHref)}
    />
  );

  const cover = (width: string) => (
    <span
      role="img"
      aria-label={coverLabel}
      className={clsx("relative block aspect-[2/3] shrink-0 overflow-hidden rounded-lg shadow-(--shadow-cover)", width)}
    >
      <BookCover book={book} className="absolute inset-0 h-full w-full" />
      <CoverProgressBadge percent={finished ? null : percent} finished={finished} showPercent={false} />
    </span>
  );

  const chapterList =
    included.length === 0 ? (
      <p className="py-4 text-md text-fg-2">
        {data.chapters.length === 0
          ? "No chapters yet. Processing will build them."
          : "No chapters are set to narrate. Include chapters under Manage."}
      </p>
    ) : (
      // Bounded internal scroll so a long chapter list never grows the
      // page into a second scrollbar; the cover column stays put.
      <ol className="scroll-thin flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto overscroll-contain">
        {/* Excluded chapters have no row here at all — they are only
            listed under Manage, where they are re-enabled. Included
            ones are numbered 1..N in playback order. */}
        {included.map((chapter, index) => (
          <li key={chapter.id}>
            <ChapterRow
              chapter={chapter}
              number={index + 1}
              state={chapterState(chapter)}
              percent={chapterPercent(chapter)}
              seconds={chapterSeconds(chapter)}
              onPlay={() => void playFrom(chapter.id)}
            />
          </li>
        ))}
      </ol>
    );

  const aboutPanel = (
    <div className="flex max-w-[640px] flex-col gap-5 pt-2" lang={book.language}>
      {book.description && <p className="text-md whitespace-pre-line leading-[1.55] text-fg">{book.description}</p>}
      <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2.5">
        {book.authors.length > 0 && (
          <>
            <dt className="text-md text-fg-2">Author</dt>
            <dd className="text-md">
              {book.authors.map((name, index) => (
                <span key={name}>
                  {index > 0 && ", "}
                  <Link to={`/search?q=${encodeURIComponent(name)}`} className="font-semibold text-fg hover:underline">
                    {name}
                  </Link>
                </span>
              ))}
            </dd>
          </>
        )}
        {series && (
          <>
            <dt className="text-md text-fg-2">Series</dt>
            <dd className="text-md">{series}</dd>
          </>
        )}
        {book.genre && (
          <>
            <dt className="text-md text-fg-2">Genre</dt>
            <dd className="text-md">{book.genre}</dd>
          </>
        )}
        {book.publisher && (
          <>
            <dt className="text-md text-fg-2">Publisher</dt>
            <dd className="text-md">{book.publisher}</dd>
          </>
        )}
        {book.published_date && (
          <>
            <dt className="text-md text-fg-2">Published</dt>
            <dd className="text-md">
              {/* A bare year stays as written; a real date/timestamp is formatted. */}
              {/^\d{4}-\d{2}/.test(book.published_date) && !Number.isNaN(Date.parse(book.published_date))
                ? formatDate(book.published_date)
                : book.published_date}
            </dd>
          </>
        )}
        <dt className="text-md text-fg-2">Language</dt>
        <dd className="text-md">{languageName(book.language)}</dd>
        {(length || data.chapters.length > 0) && (
          <>
            <dt className="text-md text-fg-2">Length</dt>
            <dd className="text-md">{[length && `About ${length}`, `${included.length} chapters`].filter(Boolean).join(" · ")}</dd>
          </>
        )}
        {voice && (
          <>
            <dt className="text-md text-fg-2">Narrator</dt>
            <dd className="text-md">{voiceLabel({ id: voice, language: book.language, description: null, available: true })}</dd>
          </>
        )}
        {(book.isbn13 ?? book.isbn10) && (
          <>
            <dt className="text-md text-fg-2">ISBN</dt>
            <dd className="text-md">{book.isbn13 ?? book.isbn10}</dd>
          </>
        )}
        <dt className="text-md text-fg-2">Added</dt>
        <dd className="text-md">{formatDate(book.created_at)}</dd>
      </dl>
      {book.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {book.tags.map((tag) => (
            <Link
              key={tag}
              to={`/search?q=${encodeURIComponent(tag)}`}
              className="tap inline-flex h-[34px] items-center rounded-full bg-raised px-3.5 text-base text-fg no-underline hover:bg-border"
            >
              {tag}
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  const managePanel = (
    <div className="flex max-w-[680px] flex-col pt-2">
      <ManageRow
        title="Details"
        description={
          <>
            Cover, title, author, description and other metadata.
            {lockedCount > 0 && (
              <> {lockedCount === 1 ? "1 field you edited is" : `${lockedCount} fields you edited are`} protected from automatic updates.</>
            )}
          </>
        }
      >
        <Link to={`/books/${id}/edit`} className={outlinePill}>
          <Icon name="Pencil" size={18} />
          Edit details
        </Link>
        <button
          type="button"
          aria-expanded={findOpen}
          onClick={() => {
            setReviewItems(null);
            setFindOpen((open) => !open);
          }}
          className={outlinePill}
        >
          <Icon name="Globe" size={18} />
          Find metadata
        </button>
      </ManageRow>
      {findOpen && (
        <div className="border-t border-border py-4">
          <FindMetadata book={book} initialItems={reviewItems ?? undefined} />
        </div>
      )}

      <section className="flex flex-col gap-1.5 border-t border-border py-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-lg font-bold">Chapters to narrate</span>
          <span className="text-sm tabular text-fg-2">{included.length} of {data.chapters.length} on</span>
        </div>
        <p className="pb-1 text-base text-fg-2">Turn off front matter you don’t want read aloud.</p>
        {/* Manage lists every chapter, excluded ones included, so it keeps
            the original source numbering (chapter.idx + 1). */}
        {(showAllChapters ? data.chapters : data.chapters.slice(0, 4)).map((chapter) => (
          <div key={chapter.id} className="flex min-h-11 items-center justify-between gap-3">
            <span className={clsx("min-w-0 flex-1 truncate text-md", chapter.excluded ? "text-fg-2" : "text-fg")}>
              {chapter.idx + 1} · {chapter.title}
            </span>
            <span className="flex shrink-0 items-center gap-3.5">
              <span className="text-sm tabular text-fg-2">{formatTime(chapterSeconds(chapter))}</span>
              <Switch
                label={`Narrate ${chapter.title}`}
                checked={!chapter.excluded}
                onChange={() => toggleChapter(chapter)}
              />
            </span>
          </div>
        ))}
        {setChapter.isError && (
          <p role="alert" className="text-sm text-danger">
            {setChapter.error.message}
          </p>
        )}
        {data.chapters.length > 4 && (
          <button
            type="button"
            onClick={() => setShowAllChapters((value) => !value)}
            className="tap self-start py-1.5 text-base font-semibold text-fg hover:underline"
          >
            {showAllChapters ? "Show less" : `Show all ${data.chapters.length}`}
          </button>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-border py-4">
        <span className="text-lg font-bold">Pronunciation</span>
        <p className="text-base text-fg-2">How the narrator says names and words in this book.</p>
        <PronunciationRules bookId={id} />
      </section>

      <ManageRow
        title="Processing"
        description={`${STATUS_LABELS[book.status] ?? book.status} · ${data.chapters.length} chapters. Reprocessing rebuilds chapters and clears generated audio; everyone’s progress is kept.`}
      >
        <button
          type="button"
          disabled={reprocess.isPending}
          onClick={() =>
            reprocess.mutate(undefined, {
              onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", id] }),
            })
          }
          className={outlinePill}
        >
          <Icon name="RefreshCw" size={18} className={reprocess.isPending ? "animate-spin" : undefined} />
          Reprocess
        </button>
      </ManageRow>
      {reprocess.isError && (
        <p role="alert" className="border-t border-border py-2 text-sm text-danger">
          {reprocess.error.message}
        </p>
      )}

      <ManageRow title="Delete book" description="Removes the book, its audio and every listener’s progress. This can’t be undone.">
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="tap inline-flex h-10 items-center gap-2 rounded-full border border-danger bg-transparent px-4 text-base font-bold text-danger hover:bg-raised"
        >
          <Icon name="Trash2" size={18} />
          Delete book
        </button>
      </ManageRow>
    </div>
  );

  const tabPanel = (
    <div role="tabpanel" id="book-panel" aria-labelledby={`book-tab-${activeTab}`} tabIndex={-1}>
      {activeTab === "Chapters" && chapterList}
      {activeTab === "About" && aboutPanel}
      {activeTab === "Manage" && canManage && managePanel}
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5">
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <p className="text-md text-fg-2">Online matches were found but not applied automatically.</p>
          <button
            type="button"
            onClick={() => {
              setReviewItems(saved);
              setFindOpen(true);
              setTab("Manage");
            }}
            className={outlinePill}
          >
            Review metadata matches
          </button>
        </div>
      )}

      {book.status === "failed" && book.error && (
        <p role="alert" className="rounded-lg border border-danger bg-surface px-3 py-2 text-md text-danger">
          {book.error}
        </p>
      )}

      {book.status !== "ready" && (
        <div>
          <StatusBadge status={book.status} />
        </div>
      )}

      {phone ? (
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Back"
              title="Back"
              onClick={() => navigate(-1)}
              className="tap grid size-11 place-items-center rounded-full text-fg hover:bg-raised"
            >
              <Icon name="ArrowLeft" size={22} />
            </button>
            {bookMenu("header")}
          </div>
          <div className="flex flex-col items-center gap-4 text-center">
            {cover("w-[180px]")}
            <div className="flex flex-col gap-1.5" lang={book.language}>
              <h1 className="font-display text-xl">{book.title}</h1>
              <Link to={authorHref} className="text-md font-semibold text-fg no-underline hover:underline">
                {book.authors.join(", ")}
              </Link>
              <p className="text-sm text-fg-2">{metaPhone}</p>
            </div>
          </div>
          {primaryButton(true)}
          <div className="flex flex-col gap-4">
            <TabList tabs={tabs} active={activeTab} onSelect={setTab} />
            {tabPanel}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-12 pt-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            {cover("w-full max-w-[300px]")}
            <div className="flex flex-col gap-2" lang={book.language}>
              <h1 className="font-display text-3xl">{book.title}</h1>
              <Link to={authorHref} className="text-[17px] font-semibold text-fg no-underline hover:underline">
                {book.authors.join(", ")}
              </Link>
              <p className="text-base text-fg-2">{metaDesktop}</p>
            </div>
            {book.description && (
              <p className={clsx("text-md leading-[1.55] text-fg-2", !expanded && "line-clamp-3")}>
                <span className="whitespace-pre-line">{book.description}</span>{" "}
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="font-semibold text-fg hover:underline"
                >
                  {expanded ? "Less" : "More"}
                </button>
              </p>
            )}
            {progress != null && (
              <div className="flex flex-col gap-2">
                <div aria-hidden className="h-1 rounded-full bg-border">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
                </div>
                <span className="text-sm tabular text-fg-2">
                  {finished
                    ? "Finished"
                    : `${percent}% · ${formatLength((book.est_duration_s ?? 0) * (1 - (progress.percent ?? 0) / 100))} left`}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5">
              {primaryButton(false)}
              {bookMenu("inline")}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <TabList tabs={tabs} active={activeTab} onSelect={setTab} />
            {tabPanel}
          </div>
        </div>
      )}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-4 lg:bottom-8">
        {toast && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-raised px-3 py-2 text-sm shadow-(--shadow-menu)">
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  setToast(null);
                  toggleFinished.mutate(false);
                }}
                className="font-bold text-fg"
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      {resetOpen && (
        <ConfirmDialog
          title={`Reset your progress in ${book.title}?`}
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
                navigate("/library");
              },
            })
          }
        />
      )}
      {editing && canManage && (
        <EditDetailsDrawer
          book={book}
          onClose={() => {
            setTab("Manage");
            navigate(`/books/${id}`, { replace: true, state: { tab: "Manage" } });
          }}
        />
      )}
      {narratorOpen && (
        <NarratorVoiceDialog
          value={book.narrator_voice}
          language={book.language}
          error={update.isError ? update.error.message : null}
          onClose={() => setNarratorOpen(false)}
          onSelect={(next) => update.mutate({ narrator_voice: next })}
        />
      )}
    </div>
  );
}
