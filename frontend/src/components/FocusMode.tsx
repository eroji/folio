/** Focus mode (handoff "Focus mode (full-screen player)", reference
 * desktop-focus-mode.html): a fixed full-window overlay on `--paper` — no
 * rail, no page, no panel. Slim header (small cover + title/author, A−/A+,
 * Contents toggle, Exit focus), an optional contents column (open by default
 * at ≥1280px, C toggles), the reading page centered at 680px, and a
 * transport card centered at the bottom. It is overlay state, not a route:
 * exiting returns to the exact page and panel state. Desktop only — on
 * phones the /player route plays this role. */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { SPEED_MAX, SPEED_MIN, formatTime, type SleepChoice } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { Icon } from "./Icon";
import { ReadAlong, useReadFontStep } from "./ReadAlong";

const SLEEP_OPTIONS: { value: SleepChoice; label: string }[] = [
  { value: null, label: "Off" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "60 minutes" },
  { value: "chapter", label: "End of chapter" },
];

function sleepText(choice: SleepChoice): string {
  if (choice === null) return "off";
  return choice === "chapter" ? "end of chapter" : `${choice} minutes`;
}

const iconButton = "tap grid size-10 shrink-0 place-items-center rounded-md text-fg hover:bg-raised";
const quietButton = clsx(iconButton, "text-fg-2");

/** `replay` with the interval drawn inside; mirrored for forward. */
function SkipGlyph({ seconds, forward }: { seconds: number; forward?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-5 items-center justify-center">
      <Icon name="replay" size={22} className={forward ? "-scale-x-100" : undefined} />
      <span className="absolute inset-0 grid place-items-center pt-px text-[8px] font-bold leading-none">{seconds}</span>
    </span>
  );
}

function SleepButton() {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Sleep timer, ${sleepText(player.sleep)}`}
        title="Sleep timer"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={quietButton}
      >
        <Icon name="bedtime" size={22} />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="Sleep timer"
            className="absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-lg border border-divider bg-surface p-1 shadow-(--shadow-menu)"
          >
            {SLEEP_OPTIONS.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                role="menuitemradio"
                aria-checked={player.sleep === option.value}
                onClick={() => {
                  player.setSleep(option.value);
                  setOpen(false);
                }}
                className="tap flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-raised"
              >
                <span className="w-5 shrink-0">{player.sleep === option.value && <Icon name="check" size={16} />}</span>
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function FocusMode({ onExit }: { onExit: () => void }) {
  const player = usePlayer();
  const navigate = useNavigate();
  const [contents, setContents] = useState(
    () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1280px)").matches,
  );
  const [step, changeFont] = useReadFontStep();
  const p = useRef(player);
  p.current = player;

  // Space toggles playback, C toggles contents, Esc exits (AppShell also
  // listens, so Esc works even from the scrubber).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onExit();
        return;
      }
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /^(?:input|textarea|select)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === "Space") {
        event.preventDefault(); // Space on a focused button would also click it
        p.current.toggle();
      } else if (event.key.toLowerCase() === "c") {
        setContents((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const book = player.book;
  if (!book) return null;

  const chapters = player.chapters;
  const currentIdx = chapters.findIndex((chapter) => chapter.id === player.chapter?.id);
  const current = currentIdx >= 0 ? chapters[currentIdx] : null;
  const chapterPercent =
    player.chapterTotal > 0 ? Math.round((player.chapterElapsed / player.chapterTotal) * 100) : null;
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  const voice = book.narrator_voice ?? player.settings.voices[book.language] ?? "default";

  return (
    <div className="fixed inset-0 z-30 flex flex-col overflow-hidden bg-paper text-fg">
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BookCover book={book} className="h-[45px] w-[30px] shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-sm font-semibold" lang={book.language}>
              {book.title}
            </span>
            <span className="truncate text-xs text-fg-2" lang={book.language}>
              {book.authors.join(", ")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Smaller text"
            title="Smaller text"
            onClick={() => changeFont(-1)}
            className="tap grid size-9 place-items-center rounded-md text-sm font-semibold hover:bg-raised"
          >
            A−
          </button>
          <button
            type="button"
            aria-label="Larger text"
            title="Larger text"
            onClick={() => changeFont(1)}
            className="tap grid size-9 place-items-center rounded-md text-base font-semibold hover:bg-raised"
          >
            A+
          </button>
          <button
            type="button"
            aria-label="Show contents"
            aria-pressed={contents}
            title="Contents (C)"
            onClick={() => setContents((value) => !value)}
            className={clsx(
              "tap grid size-9 place-items-center rounded-md",
              contents ? "bg-selected text-on-selected" : "hover:bg-raised",
            )}
          >
            <Icon name="toc" size={20} />
          </button>
          <span aria-hidden className="mx-1.5 h-5 w-px bg-divider" />
          <button
            type="button"
            aria-label="Exit focus mode"
            title="Exit focus mode (Esc)"
            onClick={onExit}
            className="tap inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium hover:bg-raised"
          >
            <Icon name="close_fullscreen" size={20} />
            Exit focus
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-6 px-5 pt-2">
        {contents && (
          <nav aria-label="Contents" className="flex w-[260px] shrink-0 flex-col gap-0.5 overflow-y-auto pt-8">
            {chapters.map((chapter, i) => {
              const isCurrent = !player.finished && i === currentIdx;
              const played = player.finished || (currentIdx >= 0 && i < currentIdx);
              return (
                <button
                  key={chapter.id}
                  type="button"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => void player.goToChapter(chapter.id)}
                  className={clsx(
                    "tap flex min-h-[34px] w-full items-center gap-2 rounded-md px-2.5 text-left text-base",
                    isCurrent ? "bg-selected font-semibold text-fg" : played ? "text-fg-2 hover:bg-raised" : "hover:bg-raised",
                  )}
                >
                  <span className={clsx("w-[18px] shrink-0 tabular", isCurrent ? "text-on-selected" : "text-fg-2")}>
                    {chapter.idx + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                  {isCurrent && chapterPercent !== null && (
                    <span className="text-xs tabular text-on-selected">{chapterPercent}%</span>
                  )}
                  {played && !isCurrent && (
                    <>
                      <Icon name="check" size={16} className="text-fg-2" />
                      <span className="sr-only">Played</span>
                    </>
                  )}
                </button>
              );
            })}
          </nav>
        )}

        <div className="flex min-w-0 flex-1 flex-col items-center">
          <div className="w-full max-w-[680px] px-2 pt-8">
            <p className="mb-1.5 text-sm font-semibold text-fg-2">Chapter {currentIdx + 1}</p>
            <h1 className="mb-8 font-display text-[2.125rem] font-bold leading-[1.15] tracking-[-0.01em]" lang={book.language}>
              {current?.title}
            </h1>
          </div>
          <ReadAlong focus fontStep={step} className="min-h-0 flex-1" />
        </div>

        {/* Keeps the reading page truly centered while contents is open, like the reference's spacer. */}
        {contents && <div aria-hidden className="w-[260px] shrink-0" />}
      </div>

      <section aria-label="Now playing" className="flex flex-none justify-center px-5 pb-5">
        <div className="flex w-full max-w-[860px] flex-col gap-1.5 rounded-lg border border-divider bg-surface px-4 py-2.5 shadow-(--shadow-menu)">
          <div className="flex items-center gap-2.5 text-xs tabular text-fg-2">
            <span>{formatTime(elapsed)}</span>
            <input
              type="range"
              aria-label="Position in chapter"
              min={0}
              max={Math.max(total, 1)}
              step={0.1}
              value={elapsed}
              onChange={(event) => player.seekChapter(Number(event.target.value))}
              className="min-w-0 flex-1 accent-progress"
            />
            <span className="whitespace-nowrap">
              −{formatTime(Math.max(0, total - elapsed))} · {player.rate}×
            </span>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <button
              type="button"
              aria-label={`Playback speed, ${player.rate} times`}
              title="Playback speed"
              onClick={() => player.setRate(player.rate >= SPEED_MAX ? SPEED_MIN : player.rate + 0.25)}
              className={quietButton}
            >
              <Icon name="speed" size={22} />
            </button>
            <span aria-hidden className="w-4" />
            <button
              type="button"
              aria-label="Previous chapter"
              title="Previous chapter"
              onClick={() => void player.stepChapter(-1)}
              className={iconButton}
            >
              <Icon name="skip_previous" size={22} />
            </button>
            <button
              type="button"
              aria-label={`Back ${player.settings.skip_back} seconds`}
              title={`Back ${player.settings.skip_back} seconds`}
              onClick={player.skipBack}
              className={iconButton}
            >
              <SkipGlyph seconds={player.settings.skip_back} />
            </button>
            <button
              type="button"
              aria-label={player.playing ? "Pause" : "Play"}
              title={player.playing ? "Pause (Space)" : "Play (Space)"}
              onClick={player.toggle}
              className="tap grid size-12 shrink-0 place-items-center rounded-full bg-primary-gradient text-on-primary"
            >
              <Icon name={player.playing ? "pause" : "play_arrow"} size={26} />
            </button>
            <button
              type="button"
              aria-label={`Forward ${player.settings.skip_forward} seconds`}
              title={`Forward ${player.settings.skip_forward} seconds`}
              onClick={player.skipForward}
              className={iconButton}
            >
              <SkipGlyph seconds={player.settings.skip_forward} forward />
            </button>
            <button
              type="button"
              aria-label="Next chapter"
              title="Next chapter"
              onClick={() => void player.stepChapter(1)}
              className={iconButton}
            >
              <Icon name="skip_next" size={22} />
            </button>
            <span aria-hidden className="w-4" />
            <SleepButton />
            <button
              type="button"
              aria-label={`Narrator voice, ${voice}`}
              title="Narrator voice"
              onClick={() => navigate(`/books/${book.id}`)}
              className={quietButton}
            >
              <Icon name="record_voice_over" size={22} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
