import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FastForward, Gauge, List, Mic, Moon, Pause, Play, RotateCcw, Type, X } from "lucide-react";
import { SPEED_MAX, SPEED_MIN, type SleepChoice } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { ChapterSheet } from "./ChapterSheet";
import { ReadAlong } from "./ReadAlong";
import { ResumePrompt } from "./ResumePrompt";

const SLEEP_STEPS: SleepChoice[] = [null, 15, 30, 45, 60, "chapter"];

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function sleepLabel(choice: SleepChoice): string {
  if (choice === null) return "Sleep";
  return choice === "chapter" ? "End of chapter" : `${choice} min`;
}

const secondaryButton =
  "flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-pill px-2 text-xs font-medium text-muted hover:text-ink";
const skipButton = "grid h-12 w-12 place-items-center rounded-pill border border-line bg-card text-ink";

/** Screen 6: full-screen player over the shell. */
export function FullPlayer({ onChangeVoice }: { onChangeVoice?: () => void }) {
  const player = usePlayer();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [readAlong, setReadAlong] = useState(false);
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
  const duration = player.chapterDuration;
  const elapsed = Math.min(player.chapterElapsed, duration);
  const remaining = Math.max(0, duration - elapsed);

  const cycleSpeed = () => player.setRate(player.rate >= SPEED_MAX ? SPEED_MIN : player.rate + 0.25);
  const cycleSleep = () => player.setSleep(SLEEP_STEPS[(SLEEP_STEPS.indexOf(player.sleep) + 1) % SLEEP_STEPS.length] ?? null);

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-page">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-8 pt-safe">
        <button
          type="button"
          aria-label="Close player"
          onClick={() => navigate(`/books/${book.id}`)}
          className="grid h-11 w-11 place-items-center self-start rounded-pill text-muted hover:text-ink"
        >
          <X size={22} strokeWidth={1.75} aria-hidden />
        </button>

        <div className="relative mx-auto my-8 w-52 max-w-full">
          <div aria-hidden className="absolute -inset-6 rounded-full bg-brand-gradient opacity-30 blur-2xl" />
          <BookCover book={book} className="relative aspect-[2/3] w-full rounded-card shadow-lg" />
        </div>

        <h1 className="text-center font-display text-xl font-semibold">{book.title}</h1>
        <p className="mt-0.5 text-center text-sm text-muted">{player.chapter?.title}</p>

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
            <RotateCcw size={22} strokeWidth={1.75} aria-hidden />
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
            <FastForward size={22} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        <div className="mt-8 flex items-start justify-between gap-1">
          <button type="button" aria-label="Change playback speed" onClick={cycleSpeed} className={secondaryButton}>
            <Gauge size={20} strokeWidth={1.75} aria-hidden />
            <span>{player.rate}×</span>
          </button>
          <button type="button" aria-label="Sleep timer" onClick={cycleSleep} className={secondaryButton}>
            <Moon size={20} strokeWidth={1.75} aria-hidden />
            <span>{sleepLabel(player.sleep)}</span>
          </button>
          <button
            type="button"
            aria-label="Chapters"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
            className={secondaryButton}
          >
            <List size={20} strokeWidth={1.75} aria-hidden />
            <span>Chapters</span>
          </button>
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

        {readAlong && <ReadAlong className="mt-6" />}
      </div>

      {sheetOpen && (
        <ChapterSheet
          book={book}
          chapters={player.chapters}
          currentId={player.chapter?.id ?? null}
          onSelect={(chapterId) => {
            player.goToChapter(chapterId);
            setSheetOpen(false);
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}
