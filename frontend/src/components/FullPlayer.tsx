import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { SPEED_MAX, SPEED_MIN, formatTime, type SleepChoice } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { Icon } from "./Icon";
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
  "tap inline-flex min-h-9 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-xs font-medium text-fg-2 hover:bg-raised";
const skipButton =
  "tap grid size-11 shrink-0 place-items-center rounded-md border border-control-border bg-surface text-fg hover:bg-raised";
const chapterButton =
  "tap grid size-9 shrink-0 place-items-center rounded-md border border-control-border bg-surface text-fg hover:bg-raised disabled:opacity-40";

/** `replay` with the interval drawn inside; mirrored for forward. */
function SkipGlyph({ seconds, forward }: { seconds: number; forward?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-5 items-center justify-center">
      <Icon name="replay" size={20} className={forward ? "-scale-x-100" : undefined} />
      <span className="absolute inset-0 grid place-items-center pt-px text-[8px] font-bold leading-none">{seconds}</span>
    </span>
  );
}

/** Screen 6: full-screen player; on phones the read-along is the content and
 * the cover/controls collapse into a compact sticky header. */
export function FullPlayer({
  onChangeVoice,
  onExit,
}: {
  onChangeVoice?: () => void;
  /** Focus mode: return to the page instead of navigating to the book. */
  onExit?: () => void;
}) {
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
        <div className="fixed inset-0 z-30 animate-pulse bg-bg p-8" aria-busy="true">
          <div className="mx-auto mt-16 aspect-[2/3] w-44 rounded-lg bg-raised" />
        </div>
      );
    }
    return (
      <div className="fixed inset-0 z-30 grid place-items-center bg-bg p-6 text-center">
        <div>
          <p className="font-display text-lg font-semibold">Nothing to play</p>
          <p className="mt-1 text-sm text-fg-2">Pick a book from the library to start listening.</p>
          <Link
            to="/"
            className="tap mt-4 inline-flex h-9 items-center rounded-md bg-primary-gradient px-4 text-base font-semibold text-on-primary"
          >
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
    <div className="fixed inset-0 z-30 flex flex-col overflow-hidden bg-bg">
      <div className="mx-auto flex h-full w-full max-w-md flex-col px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] md:max-w-2xl lg:max-w-3xl lg:px-10">
        {/* Header + controls never scroll: only the page panel below does, so
            the reader can never slide over the chapter select or scrubber. */}
        <div className="flex-none -mx-6 bg-bg px-6 pb-2 pt-safe">
          <button
            type="button"
            aria-label="Close player"
            onClick={onExit ?? (() => navigate(`/books/${book.id}`))}
            className="tap grid size-9 place-items-center self-start rounded-md text-fg-2 hover:bg-raised"
          >
            <Icon name="close" size={22} />
          </button>

          <div
            className={clsx(
              "relative mx-auto max-w-full",
              readAlong ? "my-2 w-16 lg:w-24" : "my-8 w-52 lg:w-64",
            )}
          >
            {!readAlong && (
              <div aria-hidden className="absolute -inset-6 rounded-full bg-cover-placeholder opacity-30 blur-2xl" />
            )}
            <BookCover book={book} className="relative aspect-[2/3] w-full rounded-cover shadow-lg" />
          </div>

          <h1 className="text-center font-display text-lg font-semibold">{player.chapter?.title}</h1>
          <p className="mt-0.5 truncate text-center text-sm text-fg-2">
            {book.title}
            {book.authors[0] ? ` · ${book.authors[0]}` : ""}
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous chapter"
              disabled={chapterIdx <= 0}
              onClick={() => void player.stepChapter(-1)}
              className={chapterButton}
            >
              <Icon name="skip_previous" size={20} />
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
              className="tap h-9 min-w-0 flex-1 rounded-md border border-control-border bg-surface px-3 text-base"
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
              className={chapterButton}
            >
              <Icon name="skip_next" size={20} />
            </button>
          </div>

          {player.resumePrompt && (
            <div className="mt-3">
              <ResumePrompt {...player.resumePrompt} />
            </div>
          )}

          <div aria-live="polite" className="min-h-8 pt-2 text-center">
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

          <div className="mt-2">
            <input
              type="range"
              aria-label="Seek within chapter"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={elapsed}
              onChange={(event) => player.seekChapter(Number(event.target.value))}
              className="w-full accent-progress"
            />
            <div className="flex justify-between text-xs tabular text-fg-2">
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
              <SkipGlyph seconds={player.settings.skip_back} />
            </button>
            <button
              type="button"
              aria-label={player.playing ? "Pause" : "Play"}
              onClick={player.toggle}
              className="tap grid size-12 place-items-center rounded-full bg-primary-gradient text-on-primary"
            >
              <Icon name={player.playing ? "pause" : "play_arrow"} size={26} />
            </button>
            <button
              type="button"
              aria-label={`Forward ${player.settings.skip_forward} seconds`}
              onClick={player.skipForward}
              className={skipButton}
            >
              <SkipGlyph seconds={player.settings.skip_forward} forward />
            </button>
          </div>

          <div className="mt-6 flex items-start justify-between gap-1">
            <button
              type="button"
              aria-label={`Playback speed ${player.rate}×`}
              onClick={cycleSpeed}
              className={secondaryButton}
            >
              <Icon name="speed" size={20} />
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
                <Icon name="bedtime" size={20} />
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
                    className="absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-lg border border-divider bg-surface p-1 shadow-(--shadow-menu)"
                  >
                    <p className="px-3 pb-1 pt-2 text-xs text-fg-2">Playback stops after the selected time or at the end of the chapter.</p>
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
                        className="tap flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-raised"
                      >
                        <span className="w-5 shrink-0">
                          {player.sleep === option.value && <Icon name="check" size={16} />}
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
              <Icon name="toc" size={20} />
              <span>Read along</span>
            </button>
            <button
              type="button"
              aria-label="Voice"
              onClick={onChangeVoice ?? (() => navigate(`/books/${book.id}`))}
              className={secondaryButton}
            >
              <Icon name="record_voice_over" size={20} />
              <span>Voice</span>
            </button>
          </div>
        </div>

        {readAlong && <ReadAlong className="mt-3 min-h-0 flex-1 pb-2" />}
      </div>
    </div>
  );
}
