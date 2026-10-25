import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  FastForward,
  Gauge,
  Mic,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Type,
  X,
} from "lucide-react";
import { SPEED_MAX, SPEED_MIN, formatTime, type SleepChoice } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { ReadAlong } from "./ReadAlong";
import { ResumePrompt } from "./ResumePrompt";

const SLEEP_OPTIONS: { value: SleepChoice; label: string }[] = [
  { value: null, label: "Off" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "60 minutes" },
  { value: "chapter", label: "End of chapter" },
];

/** Trigger label: the active choice, never a bare "Sleep". */
function sleepLabel(choice: SleepChoice): string {
  if (choice === null) return "Sleep timer";
  return choice === "chapter" ? "End of chapter" : `${choice} min`;
}

const secondaryButton =
  "flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-pill px-2 text-xs font-medium text-muted hover:text-ink";
const skipButton =
  "flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-pill border border-line bg-card text-ink";

/** Screen 6: full-screen player; on phones the read-along is the content and
 * the cover/controls collapse into a compact sticky header. */
export function FullPlayer({ onChangeVoice }: { onChangeVoice?: () => void }) {
  const player = usePlayer();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [sleepOpen, setSleepOpen] = useState(false);
  const [readAlong, setReadAlong] = useState(true);
  const p = useRef(player);
  p.current = player;

  const bookId = params.get("book");
  useEffect(() => {
    if (bookId && bookId !== p.current.book?.id) {
      void p.current.load(bookId, params.get("chapter") ?? undefined);
    }
  }, [bookId, params]);

  useEffect(() => {
    // Spec UX rules: space toggles play, arrows seek (desktop).
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.code === "Space") {
        event.preventDefault();
        p.current.toggle();
      } else if (event.key === "ArrowRight") {
        p.current.skipForward();
      } else if (event.key === "ArrowLeft") {
        p.current.skipBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!player.book) {
    if (bookId) {
      return (
        <div className="fixed inset-0 z-30 animate-pulse bg-page p-8" aria-busy="true">
          <div className="mx-auto mt-16 aspect-[2/3] w-44 rounded-card bg-card" />
        </div>
      );
    }
    return (
      <div className="fixed inset-0 z-30 grid place-items-center bg-page p-6 text-center">
        <div>
          <p className="font-display text-lg font-semibold">Nothing to play</p>
          <p className="mt-1 text-sm text-muted">Pick a book from the library to start listening.</p>
          <Link to="/" className="mt-4 inline-flex min-h-11 items-center rounded-pill bg-brand-gradient px-5 font-medium text-white">
            Back to library
          </Link>
        </div>
      </div>
    );
  }

  const book = player.book;
  const duration = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, duration);
  const remaining = Math.max(0, duration - elapsed);
  const chapterIdx = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id);

  const cycleSpeed = () => player.setRate(player.rate >= SPEED_MAX ? SPEED_MIN : player.rate + 0.25);

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-page">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-[calc(2rem+env(safe-area-inset-bottom))] md:max-w-2xl lg:max-w-3xl lg:px-10">
        <div className="sticky top-0 z-10 -mx-6 bg-page/95 px-6 pb-2 pt-safe backdrop-blur">
          <button
            type="button"
            aria-label="Close player"
            onClick={() => navigate(`/books/${book.id}`)}
            className="grid h-11 w-11 place-items-center self-start rounded-pill text-muted hover:text-ink"
          >
            <X size={22} strokeWidth={1.75} aria-hidden />
          </button>

          <div
            className={clsx(
              "relative mx-auto max-w-full",
              readAlong ? "my-2 w-16 lg:w-24" : "my-8 w-52 lg:w-64",
            )}
          >
            {!readAlong && (
              <div aria-hidden className="absolute -inset-6 rounded-full bg-brand-gradient opacity-30 blur-2xl" />
            )}
            <BookCover book={book} className="relative aspect-[2/3] w-full rounded-card shadow-lg" />
          </div>

          <h1 className="text-center font-display text-2xl font-semibold">{player.chapter?.title}</h1>
          <p className="mt-0.5 truncate text-center text-sm text-muted">
            {book.title}
            {book.authors[0] ? ` · ${book.authors[0]}` : ""}
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous chapter"
              disabled={chapterIdx <= 0}
              onClick={() => void player.stepChapter(-1)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-line bg-card text-ink disabled:opacity-40"
            >
              <ChevronsLeft size={20} strokeWidth={1.75} aria-hidden />
            </button>
            <select
              aria-label="Chapter"
              value={player.chapter?.id ?? ""}
              onChange={(event) => {
                const chapterId = event.target.value;
                if (chapterId && chapterId !== player.chapter?.id) {
                  void player.goToChapter(chapterId).then(() => void player.play());
                }
              }}
              className="h-11 min-w-0 flex-1 rounded-card border border-line bg-card px-3 text-sm"
            >
              {player.chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.idx + 1} · {chapter.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Next chapter"
              disabled={chapterIdx >= player.chapters.length - 1}
              onClick={() => void player.stepChapter(1)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-line bg-card text-ink disabled:opacity-40"
            >
              <ChevronsRight size={20} strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          {player.resumePrompt && (
            <div className="mt-3">
              <ResumePrompt {...player.resumePrompt} />
            </div>
          )}

          <div aria-live="polite" className="min-h-8 pt-2 text-center">
            {player.preparing && (
              <p role="status" className="text-sm text-muted">
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

          <div className="mt-2">
            <input
              type="range"
              aria-label="Seek within chapter"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={elapsed}
              onChange={(event) => player.seekChapter(Number(event.target.value))}
              className="w-full accent-brand-blue"
            />
            <div className="flex justify-between text-xs tabular-nums text-muted">
              <span data-testid="player-elapsed">{formatTime(elapsed)}</span>
              <span>-{formatTime(remaining)}</span>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-center gap-8">
            <button
              type="button"
              aria-label={`Back ${player.settings.skip_back} seconds`}
              onClick={player.skipBack}
              className={skipButton}
            >
              <RotateCcw size={20} strokeWidth={1.75} aria-hidden />
              <span aria-hidden className="text-[10px] font-medium tabular-nums">
                {player.settings.skip_back}
              </span>
            </button>
            <button
              type="button"
              aria-label={player.playing ? "Pause" : "Play"}
              onClick={player.toggle}
              className="grid h-16 w-16 place-items-center rounded-pill bg-brand-gradient text-white"
            >
              {player.playing ? <Pause size={28} strokeWidth={1.75} aria-hidden /> : <Play size={28} strokeWidth={1.75} aria-hidden />}
            </button>
            <button
              type="button"
              aria-label={`Forward ${player.settings.skip_forward} seconds`}
              onClick={player.skipForward}
              className={skipButton}
            >
              <FastForward size={20} strokeWidth={1.75} aria-hidden />
              <span aria-hidden className="text-[10px] font-medium tabular-nums">
                {player.settings.skip_forward}
              </span>
            </button>
          </div>

          <div className="mt-6 flex items-start justify-between gap-1">
            <button type="button" aria-label="Change playback speed" onClick={cycleSpeed} className={secondaryButton}>
              <Gauge size={20} strokeWidth={1.75} aria-hidden />
              <span>{player.rate}×</span>
            </button>
            <div className="relative">
              <button
                type="button"
                aria-label={`Sleep timer, currently ${player.sleep === null ? "off" : sleepLabel(player.sleep)}. Choose when playback stops.`}
                aria-expanded={sleepOpen}
                onClick={() => setSleepOpen((open) => !open)}
                className={secondaryButton}
              >
                <Moon size={20} strokeWidth={1.75} aria-hidden />
                <span>{sleepLabel(player.sleep)}</span>
              </button>
              {sleepOpen && (
                <>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setSleepOpen(false)}
                  />
                  <div
                    role="menu"
                    aria-label="Sleep timer"
                    className="absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-card border border-line bg-card p-1 shadow-lg"
                  >
                    <p className="px-3 pb-1 pt-2 text-xs text-muted">Playback stops after the selected time or at the end of the chapter.</p>
                    {SLEEP_OPTIONS.map((option) => (
                      <button
                        key={String(option.value)}
                        type="button"
                        role="menuitemradio"
                        aria-checked={player.sleep === option.value}
                        onClick={() => {
                          player.setSleep(option.value);
                          setSleepOpen(false);
                        }}
                        className="flex min-h-11 w-full items-center gap-2 rounded-card px-3 py-2 text-left text-sm hover:bg-page"
                      >
                        <span className="w-5 shrink-0">
                          {player.sleep === option.value && <Check size={16} strokeWidth={1.75} aria-hidden />}
                        </span>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              aria-label="Read along"
              aria-pressed={readAlong}
              onClick={() => setReadAlong((open) => !open)}
              className={secondaryButton}
            >
              <Type size={20} strokeWidth={1.75} aria-hidden />
              <span>Read along</span>
            </button>
            <button
              type="button"
              aria-label="Voice"
              onClick={onChangeVoice ?? (() => navigate(`/books/${book.id}`))}
              className={secondaryButton}
            >
              <Mic size={20} strokeWidth={1.75} aria-hidden />
              <span>Voice</span>
            </button>
          </div>
        </div>

        {readAlong && <ReadAlong className="mt-4" />}
      </div>
    </div>
  );
}
