/** The expanded Now playing page at /player (handoff "Now playing,
 * expanded"). ≥768px: two columns inside the shell (sidebar stays, player
 * bar stays at the bottom with "Close player"). <768px: a full-screen phone
 * player whose bottom tabs open UP NEXT / READ ALONG / ABOUT as a sheet.
 * Transport lives in the player bar on desktop and on the phone player
 * itself; this page never duplicates it on desktop. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import type { Book } from "../api/types";
import { useBook } from "../api/books";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSwipeDown } from "../hooks/useSwipeDown";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { ChapterRow } from "./ChapterRow";
import { Icon } from "./Icon";
import { ChapterNavButton, ChapterScrubber, PlayButton, SkipButton, SpeedButton, iconButton } from "./PlayerControls";
import { ListeningControls } from "./ListeningControls";
import { AutoScrollToggle, ReadAlong, TextSizePicker, useReadAlongControls } from "./ReadAlong";
import { ResumePrompt } from "./ResumePrompt";
import { preparingPercent, preparingText } from "../player/preparing";
import { FROM_PLAYER } from "../player/fromPlayer";

type PanelTab = "next" | "read" | "about";
const TABS: { id: PanelTab; label: string }[] = [
  { id: "next", label: "Up next" },
  { id: "read", label: "Read along" },
  { id: "about", label: "About" },
];

/** Cover glow: strong (player) or normal (book page) tint from the cover
 * color, falling back to the accent page glow when unknown. */
export function coverGlow(
  book: Book | null | undefined,
  strong = true,
): { className: string; style?: CSSProperties } {
  return book?.cover_rgb
    ? {
        className: strong ? "bg-cover-glow-strong" : "bg-cover-glow",
        style: { "--cover-rgb": book.cover_rgb } as CSSProperties,
      }
    : { className: "bg-page-glow" };
}

function PlayerTabs({
  tab,
  onSelect,
  className,
}: {
  tab: PanelTab | null;
  onSelect: (tab: PanelTab) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label="Player panels"
      className={clsx("flex border-b border-border", className)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const i = TABS.findIndex((t) => t.id === tab);
        const next = (i + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
        onSelect(TABS[next]!.id);
        refs.current[next]?.focus();
      }}
    >
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(node) => {
            refs.current[i] = node;
          }}
          type="button"
          role="tab"
          id={`player-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`player-panel-${t.id}`}
          tabIndex={(tab ?? TABS[0]!.id) === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
          className={clsx(
            "h-12 flex-1 rounded-none border-b-2 bg-transparent text-base font-bold uppercase tracking-[0.08em]",
            tab === t.id ? "border-fg text-fg" : "border-transparent text-fg-2 hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function UpNext() {
  const player = usePlayer();
  const book = player.book;
  // The book query carries this listener's per-chapter places (refetched on save).
  const { data } = useBook(book?.id ?? "");
  if (!book) return null;
  const currentIdx = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id);
  const remaining = player.chapters.slice(currentIdx + 1);
  const secondsPerChar =
    book.est_duration_s && book.total_chars ? book.est_duration_s / book.total_chars : 1 / 15;
  const progressOf = new Map((data?.chapters ?? []).map((chapter) => [chapter.id, chapter.progress]));
  if (remaining.length === 0) {
    return <p className="text-md text-fg-2">Nothing left in this book.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {remaining.map((chapter, index) => {
        const place = progressOf.get(chapter.id);
        const percent = place?.segment_id ? Math.round(place.percent) : 0;
        return (
          <ChapterRow
            key={chapter.id}
            chapter={chapter}
            number={currentIdx + 2 + index}
            state={place?.finished ? "played" : null}
            percent={percent > 0 ? percent : null}
            seconds={chapter.char_count * secondsPerChar}
            onPlay={() => void player.goToChapter(chapter.id).then(() => player.play())}
          />
        );
      })}
    </div>
  );
}

function AboutPanel() {
  const player = usePlayer();
  const book = player.book;
  if (!book) return null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <BookCover book={book} showPlaceholderText={false} className="aspect-[2/3] w-20 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display text-xl" lang={book.language}>
            {book.title}
          </h2>
          <p className="truncate text-md text-fg-2">{book.authors.join(", ") || "Unknown author"}</p>
        </div>
      </div>
      {book.description && (
        <p className="line-clamp-3 text-md text-fg-2" lang={book.language}>
          {book.description}
        </p>
      )}
      <Link
        to={`/books/${book.id}`}
          state={FROM_PLAYER}
        className="tap inline-flex h-10 w-fit items-center rounded-full border border-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised"
      >
        Open book
      </Link>
    </div>
  );
}

function PlayerStatus() {
  const player = usePlayer();
  if (!player.preparing && !player.error) return null;
  return (
    <div aria-live="polite" className="text-center">
      {player.preparing && (
        <>
          <p role="status" className="text-sm tabular text-fg-2">
            {preparingText(player.preparingProgress)}
          </p>
          {player.preparingProgress && player.preparingProgress.total > 1 && (
            <div
              aria-hidden
              data-preparing-bar
              className="mx-auto mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-border"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${preparingPercent(player.preparingProgress)}%` }}
              />
            </div>
          )}
        </>
      )}
      {player.error && (
        <p role="alert" className="text-sm text-danger">
          {player.error}{" "}
          <button type="button" onClick={player.retry} className="font-medium underline">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

function DesktopPlayer({ book }: { book: Book }) {
  const player = usePlayer();
  const [tab, setTab] = useState<PanelTab>("read");
  const chapterNumber = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id) + 1;
  return (
    <div className="mx-auto grid h-full min-h-0 w-full max-w-[1080px] grid-cols-1 gap-12 overflow-hidden pt-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col items-center gap-6">
        <Link
          to={`/books/${book.id}`}
          state={FROM_PLAYER}
          aria-label={`Open ${book.title}`}
          className="block w-full max-w-[300px] self-start no-underline"
        >
          <span className="relative block aspect-[2/3] w-full overflow-hidden rounded-xl shadow-(--shadow-cover)">
            <BookCover book={book} showPlaceholderText={false} className="absolute inset-0 h-full w-full" />
          </span>
        </Link>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="font-display text-2xl" lang={book.language}>
            {player.chapter?.title}
          </h1>
          <p className="text-lg text-fg-2">
            Chapter {chapterNumber} · {book.title}
            {book.authors[0] ? ` · ${book.authors.join(", ")}` : ""}
          </p>
        </div>
        <PlayerStatus />
        {player.resumePrompt && (
          <div className="w-full max-w-[420px]">
            <ResumePrompt {...player.resumePrompt} />
          </div>
        )}
      </div>
      <div className="flex min-h-0 min-w-0 max-w-[620px] flex-col gap-4">
        <PlayerTabs tab={tab} onSelect={setTab} />
        {/* Exactly one scroll container per tab: the read-along panel scrolls
            inside ReadAlong; the other tabs scroll here. Never the document. */}
        <div
          role="tabpanel"
          id={`player-panel-${tab}`}
          aria-labelledby={`player-tab-${tab}`}
          className={clsx("min-h-0 flex-1", tab === "read" ? "flex flex-col overflow-hidden" : "scroll-thin overflow-y-auto")}
        >
          {tab === "read" && <ReadAlong className="min-h-0 flex-1" />}
          {tab === "next" && <UpNext />}
          {tab === "about" && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}

/** X on the phone player: stop and close (the desktop bar's control). */
function StopButton() {
  const player = usePlayer();
  return (
    <button
      type="button"
      aria-label="Stop and close player"
      title="Stop and close player"
      onClick={player.stop}
      className={iconButton}
    >
      <Icon name="X" size={22} />
    </button>
  );
}

function PhoneSheet({
  tab,
  onSelect,
  onClose,
  controls,
  book,
}: {
  tab: PanelTab;
  onSelect: (tab: PanelTab) => void;
  onClose: () => void;
  controls: ReturnType<typeof useReadAlongControls>;
  book: Book;
}) {
  const player = usePlayer();
  const glow = coverGlow(book);
  const swipe = useSwipeDown(onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className={clsx("fixed inset-0 z-40 flex flex-col overflow-hidden pt-safe", glow.className)}
      style={{ ...glow.style, ...swipe.style }}
    >
      {/* The whole header drags the sheet down to close it; the handle is
          also a button (tap, keyboard, screen readers). */}
      <div className="flex shrink-0 touch-none flex-col px-4" {...swipe.handlers}>
        <button
          type="button"
          aria-label="Back to player"
          title="Back to player"
          onClick={onClose}
          className="tap -mb-1 flex h-11 w-full items-center justify-center"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-border" />
        </button>
        <div className="flex items-center gap-3">
          <Link to={`/books/${book.id}`}
          state={FROM_PLAYER} className="flex min-w-0 flex-1 items-center gap-2.5 no-underline">
            <BookCover book={book} showPlaceholderText={false} className="aspect-[2/3] w-7 shrink-0 rounded-xs" />
            <span className="flex min-w-0 flex-col text-left">
              <span className="truncate text-md font-semibold text-fg">{player.chapter?.title}</span>
              <span className="truncate text-sm text-fg-2">{book.title}</span>
            </span>
          </Link>
          {/* The read-along view's own settings sit together. */}
          {tab === "read" && <AutoScrollToggle value={controls.autoScroll} onChange={controls.setAutoScroll} />}
          <TextSizePicker step={controls.sizeStep} onStep={controls.setSizeStep} />
        </div>
        <PlayerTabs tab={tab} onSelect={onSelect} className="mt-2.5" />
      </div>
      <div
        role="tabpanel"
        id={`player-panel-${tab}`}
        aria-labelledby={`player-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col px-4"
      >
        {tab === "read" && <ReadAlong phone toolbar={false} controls={controls} className="min-h-0 flex-1 py-3" />}
        {tab === "next" && (
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
            <UpNext />
          </div>
        )}
        {tab === "about" && (
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
            <AboutPanel />
          </div>
        )}
      </div>
      {tab === "read" && (
        <section aria-label="Playback" className="flex shrink-0 flex-col gap-1.5 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-2.5">
          <ChapterScrubber />
          <div className="flex items-center justify-between">
            <SpeedButton className="bg-raised" />
            <SkipButton direction="back" />
            <PlayButton size={60} />
            <SkipButton direction="forward" />
            {/* Keeps play centred where the close chevron used to sit. */}
            <span aria-hidden className="size-11" />
          </div>
        </section>
      )}
    </div>
  );
}

function PhonePlayer({ book }: { book: Book }) {
  const player = usePlayer();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<PanelTab | null>(null);
  const controls = useReadAlongControls();
  const glow = coverGlow(book);
  const chapterNumber = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id) + 1;
  return (
    <div className={clsx("fixed inset-0 z-30 flex flex-col overflow-hidden pt-safe", glow.className)} style={glow.style}>
      <header className="flex h-14 shrink-0 items-center justify-between px-2">
        <button
          type="button"
          aria-label="Close player"
          title="Close player"
          onClick={() => navigate(`/books/${book.id}`, { state: FROM_PLAYER })}
          className={iconButton}
        >
          <Icon name="ChevronDown" size={22} />
        </button>
        <span className="eyebrow">Now playing</span>
        <StopButton />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-4">
        <Link
          to={`/books/${book.id}`}
          state={FROM_PLAYER}
          aria-label={`Open ${book.title}`}
          className="mx-auto block shrink-0 no-underline"
        >
          <span className="relative block aspect-[2/3] w-[236px] overflow-hidden rounded-lg shadow-(--shadow-cover)">
            <BookCover book={book} showPlaceholderText={false} className="absolute inset-0 h-full w-full" />
          </span>
        </Link>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="font-display text-xl" lang={book.language}>
            {player.chapter?.title}
          </h1>
          <p className="truncate text-sm text-fg-2">
            {book.title} · Ch. {chapterNumber}
          </p>
        </div>
        <PlayerStatus />
        {player.resumePrompt && <ResumePrompt {...player.resumePrompt} />}
        <ChapterScrubber />
        <div className="flex items-center justify-between">
          <ChapterNavButton delta={-1} />
          <SkipButton direction="back" />
          <PlayButton size={72} />
          <SkipButton direction="forward" />
          <ChapterNavButton delta={1} />
        </div>
        <ListeningControls layout="card" />
        <PlayerTabs
          tab={sheet}
          onSelect={(t) => setSheet((current) => (current === t ? null : t))}
          className="mt-auto -mx-4 border-t border-b-0 pb-safe"
        />
      </div>
      {sheet && <PhoneSheet tab={sheet} onSelect={setSheet} onClose={() => setSheet(null)} controls={controls} book={book} />}
    </div>
  );
}

export function PlayerPage() {
  const player = usePlayer();
  const [params] = useSearchParams();
  const phone = !useMediaQuery("(min-width: 768px)");
  const bookId = params.get("book");
  const p = useRef(player);
  p.current = player;

  useEffect(() => {
    if (bookId && bookId !== p.current.book?.id) {
      void p.current.load(bookId, params.get("chapter") ?? undefined);
    }
  }, [bookId, params]);

  if (!player.book) {
    if (bookId) {
      return (
        <div className="mx-auto flex w-full max-w-[420px] flex-col gap-4 py-8" aria-busy="true">
          <div className="mx-auto aspect-[2/3] w-44 animate-pulse rounded-xl bg-raised" />
          <div className="mx-auto h-6 w-40 animate-pulse rounded-full bg-raised" />
        </div>
      );
    }
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-16 text-center">
        <h1 className="font-display text-xl">Nothing to play</h1>
        <p className="text-md text-fg-2">Pick a book from the library to start listening.</p>
        <Link
          to="/library"
          className="tap mt-3 inline-flex h-10 items-center rounded-full bg-fg px-4 text-base font-bold text-on-fg no-underline"
        >
          Back to library
        </Link>
      </div>
    );
  }

  return phone ? <PhonePlayer book={player.book} /> : <DesktopPlayer book={player.book} />;
}
