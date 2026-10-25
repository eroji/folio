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
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { ChapterRow } from "./ChapterRow";
import { Icon } from "./Icon";
import { ChapterNavButton, ChapterScrubber, PlayButton, SkipButton, SleepButton, SpeedButton, iconButton } from "./PlayerControls";
import { ReadAlong, useReadAlongControls } from "./ReadAlong";
import { ResumePrompt } from "./ResumePrompt";

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
  if (!book) return null;
  const currentIdx = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id);
  const remaining = player.chapters.slice(currentIdx + 1);
  const secondsPerChar =
    book.est_duration_s && book.total_chars ? book.est_duration_s / book.total_chars : 1 / 15;
  if (remaining.length === 0) {
    return <p className="text-md text-fg-2">Nothing left in this book.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {remaining.map((chapter) => (
        <ChapterRow
          key={chapter.id}
          chapter={chapter}
          number={chapter.idx + 1}
          state={null}
          seconds={chapter.char_count * secondsPerChar}
          onPlay={() => void player.goToChapter(chapter.id).then(() => player.play())}
        />
      ))}
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
        <BookCover book={book} className="aspect-[2/3] w-20 shrink-0 rounded-lg" />
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
        className="tap inline-flex h-10 w-fit items-center rounded-full border border-control-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised"
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
        <p role="status" className="text-sm text-fg-2">
          Preparing audio…
        </p>
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
    <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-start gap-12 pt-6">
      <div className="flex flex-1 basis-[360px] flex-col items-center gap-6">
        <span className="relative block aspect-[2/3] w-full max-w-[360px] overflow-hidden rounded-xl shadow-(--shadow-cover)">
          <BookCover book={book} className="absolute inset-0 h-full w-full" />
        </span>
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
      <div className="flex min-w-0 max-w-[620px] flex-1 basis-[420px] flex-col gap-4">
        <PlayerTabs tab={tab} onSelect={setTab} />
        <div
          role="tabpanel"
          id={`player-panel-${tab}`}
          aria-labelledby={`player-tab-${tab}`}
          className="flex min-h-0 flex-col"
          style={{ height: tab === "read" ? "min(560px, 60vh)" : undefined }}
        >
          {tab === "read" && <ReadAlong className="min-h-0 flex-1" />}
          {tab === "next" && <UpNext />}
          {tab === "about" && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}

/** ⋮ on the phone player: the stop control the desktop bar owns. */
function PhoneMoreMenu() {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="More options"
        title="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={iconButton}
      >
        <Icon name="EllipsisVertical" size={22} />
      </button>
      {open && (
        <>
          <button type="button" tabIndex={-1} aria-hidden className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="More options" className="absolute top-full right-0 z-20 mt-1 w-56 rounded-xl border border-border bg-raised p-1 shadow-(--shadow-menu)">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                player.stop();
              }}
              className="tap flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-base hover:bg-border"
            >
              <Icon name="X" size={18} /> Stop and close
            </button>
          </div>
        </>
      )}
    </div>
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
  return (
    <div className={clsx("fixed inset-0 z-40 flex flex-col overflow-hidden pt-safe", glow.className)} style={glow.style}>
      <div className="flex shrink-0 flex-col gap-1.5 px-4">
        <span aria-hidden className="mx-auto mt-1.5 h-1 w-10 rounded-full bg-border" />
        <div className="flex items-center gap-3 pt-1.5">
          <button type="button" aria-label="Back to player" title="Back to player" onClick={onClose} className={iconButton}>
            <Icon name="ChevronDown" size={22} />
          </button>
          <Link to={`/books/${book.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 no-underline">
            <BookCover book={book} className="aspect-[2/3] w-7 shrink-0 rounded-xs" />
            <span className="flex min-w-0 flex-col text-left">
              <span className="truncate text-md font-semibold text-fg">{player.chapter?.title}</span>
              <span className="truncate text-sm text-fg-2">{book.title}</span>
            </span>
          </Link>
          <button
            type="button"
            aria-label="Text size"
            title="Text size"
            onClick={controls.cycleFont}
            className="tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised"
          >
            <Icon name="AlignLeft" size={18} />
          </button>
        </div>
        <PlayerTabs tab={tab} onSelect={onSelect} className="mt-1" />
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
            <button
              type="button"
              aria-label={`Auto-scroll ${controls.autoScroll ? "on" : "off"}`}
              aria-pressed={controls.autoScroll}
              title="Auto-scroll"
              onClick={() => controls.setAutoScroll(!controls.autoScroll)}
              className={clsx(iconButton, controls.autoScroll && "text-accent")}
            >
              <Icon name="ChevronsDown" size={22} />
            </button>
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
          onClick={() => navigate(`/books/${book.id}`)}
          className={iconButton}
        >
          <Icon name="ChevronDown" size={22} />
        </button>
        <span className="eyebrow">Now playing</span>
        <PhoneMoreMenu />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 px-4">
        <span className="relative mx-auto block aspect-[2/3] w-[236px] shrink-0 overflow-hidden rounded-lg shadow-(--shadow-cover)">
          <BookCover book={book} className="absolute inset-0 h-full w-full" />
        </span>
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
        <div className="flex items-center justify-between">
          <SpeedButton className="bg-raised" />
          <SleepButton />
        </div>
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
