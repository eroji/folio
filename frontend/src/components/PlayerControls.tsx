/** Controls shared by every Direction D player surface (player bar, phone
 * mini player, expanded player, phone player and sheet). All of them drive
 * the single PlayerProvider state. */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { formatSpeed, formatTime, type SleepChoice } from "../player/PlayerProvider";
import { snapSpeed, speedPositions, useSpeedOptions } from "../api/settings";
import { usePlayer } from "../player/usePlayer";
import { Icon } from "./Icon";

export const iconButton = "tap grid size-10 shrink-0 place-items-center rounded-full text-fg hover:bg-raised";

/** "2 min ago" style relative time for the other-device line. */
export function timeAgo(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { style: "short", numeric: "auto" });
  if (seconds < 60) return rtf.format(-Math.round(seconds), "second");
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return rtf.format(-Math.round(seconds / 3600), "hour");
  return rtf.format(-Math.round(seconds / 86_400), "day");
}

/** White pill play/pause (handoff: primary action is white, never accent). */
export function PlayButton({ size }: { size: 40 | 44 | 48 | 60 | 72 }) {
  const player = usePlayer();
  const box = { 40: "size-10", 44: "size-11", 48: "size-12", 60: "size-[60px]", 72: "size-[72px]" }[size];
  const glyph = { 40: 18, 44: 20, 48: 24, 60: 28, 72: 32 }[size];
  return (
    <button
      type="button"
      aria-label={player.playing ? "Pause" : "Play"}
      title={player.playing ? "Pause" : "Play"}
      onClick={player.toggle}
      className={clsx("tap grid shrink-0 place-items-center rounded-full bg-fg text-on-fg", box)}
    >
      <Icon name={player.playing ? "Pause" : "Play"} size={glyph} />
    </button>
  );
}

/** Both directions use the Replay glyph — forward is the same glyph mirrored
 * horizontally, never a different icon; the name carries the seconds. */
export function SkipButton({ direction }: { direction: "back" | "forward" }) {
  const player = usePlayer();
  const seconds = direction === "back" ? player.settings.skip_back : player.settings.skip_forward;
  const label = `${direction === "back" ? "Back" : "Forward"} ${seconds} seconds`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={direction === "back" ? player.skipBack : player.skipForward}
      className={iconButton}
    >
      <Icon name="RotateCcw" size={22} className={direction === "forward" ? "-scale-x-100" : undefined} />
    </button>
  );
}

export function ChapterNavButton({ delta }: { delta: -1 | 1 }) {
  const player = usePlayer();
  const label = delta === -1 ? "Previous chapter" : "Next chapter";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void player.stepChapter(delta)}
      className={iconButton}
    >
      <Icon name={delta === -1 ? "SkipBack" : "SkipForward"} size={22} />
    </button>
  );
}

/** The card closes this long after the last change (timer resets on each). */
const SPEED_AUTO_CLOSE_MS = 3000;

/** Speed as a text button opening the speed card (handoff "Playback speed
 * slider"): current value + eyebrow above a 210px vertical track with step
 * dots; the grid comes from config (useSpeedOptions), never hard-coded. The
 * card centers above the button — on the phone controls pass
 * placement="sheet" and the card sits centered in a small bottom sheet.
 * Closes on Esc, outside click, or 3 s after the last change. */
export function SpeedButton({ className, placement = "center" }: { className?: string; placement?: "center" | "sheet" }) {
  const player = usePlayer();
  const { options } = useSpeedOptions();
  const positions = speedPositions(options);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const current = snapSpeed(player.rate, options);
  const fraction =
    positions.length > 1 ? (current - options.min) / (options.max - options.min) : 0;

  function armClose() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), SPEED_AUTO_CLOSE_MS);
  }

  function change(rate: number) {
    player.setRate(rate); // apply to playback immediately
    armClose(); // the 3 s window restarts on every change
  }

  /** Value at a clientY on the track (bottom = min), snapped to the grid. */
  function valueFromY(clientY: number): number {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return current;
    const ratio = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return snapSpeed(options.min + ratio * (options.max - options.min), options);
  }
  const dragTo = useRef<(y: number) => void>(() => {});
  dragTo.current = (y: number) => change(valueFromY(y));

  useEffect(() => {
    if (!open) return;
    track.current?.focus();
    armClose(); // a card nobody touches closes after 3 s too
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => dragTo.current(event.clientY);
    const onUp = () => setDragging(false);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  function onKeyDown(event: ReactKeyboardEvent) {
    const index = Math.round((current - options.min) / options.step);
    let next: number;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = index - 1;
        break;
      case "PageUp":
        next = index + 2;
        break;
      case "PageDown":
        next = index - 2;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = positions.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    change(positions[Math.min(positions.length - 1, Math.max(0, next))]!);
  }

  const card = (
    <div
      role="dialog"
      aria-label="Playback speed"
      className={clsx(
        "w-[84px] rounded-2xl border border-border bg-raised px-2.5 pt-4 pb-[18px] shadow-(--shadow-menu)",
        placement === "sheet"
          ? "relative z-30"
          : "absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2",
      )}
    >
      <div className="flex flex-col items-center gap-0.5">
        <span aria-live="polite" className="font-display text-[20px] tabular">
          {formatSpeed(player.rate)}×
        </span>
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-2">Speed</span>
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Playback speed"
        aria-orientation="vertical"
        aria-valuemin={options.min}
        aria-valuemax={options.max}
        aria-valuenow={current}
        aria-valuetext={`${formatSpeed(player.rate)} times`}
        className="relative mx-auto mt-3.5 h-[210px] w-7 cursor-pointer touch-none"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
          change(valueFromY(event.clientY));
        }}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2 rounded-full bg-[#34343A]" />
        <span
          data-speed-fill
          aria-hidden
          className="absolute bottom-0 left-1/2 w-2 -translate-x-1/2 rounded-full bg-accent"
          style={{ height: `${fraction * 100}%` }}
        />
        {positions.map((value, i) => (
          <span
            key={value}
            data-speed-step
            aria-hidden
            className={clsx(
              "absolute left-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
              value <= current ? "bg-bg/55" : "bg-[#5A5A62]",
            )}
            style={{ top: `${(1 - i / Math.max(1, positions.length - 1)) * 100}%` }}
          />
        ))}
        <span
          data-speed-thumb
          aria-hidden
          className="absolute left-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg shadow-[0_0_0_4px_rgb(var(--accent-rgb)/0.35),0_2px_6px_rgb(0_0_0/0.5)]"
          style={{ top: `${(1 - fraction) * 100}%` }}
        />
      </div>
    </div>
  );

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Playback speed, ${formatSpeed(player.rate)} times`}
        title="Playback speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          // fixed width + tabular digits: a longer label must not resize the box and shift the row.
          "tap h-10 w-14 shrink-0 rounded-full text-center text-base font-semibold tabular text-fg hover:bg-raised",
          open && "bg-raised",
          className,
        )}
      >
        {formatSpeed(player.rate)}×
      </button>
      {open &&
        (placement === "sheet" ? (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="fixed inset-0 z-20 cursor-default bg-bg/60"
              onClick={() => setOpen(false)}
            />
            <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center rounded-t-2xl border-t border-border bg-surface pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {card}
            </div>
          </>
        ) : (
          card
        ))}
    </div>
  );
}

const SLEEP_OPTIONS: { value: SleepChoice; label: string }[] = [
  { value: null, label: "Off" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "60 minutes" },
  { value: "chapter", label: "End of chapter" },
];

function sleepText(choice: SleepChoice): string {
  if (choice === null) return "Sleep timer";
  return choice === "chapter" ? "Sleep timer, end of chapter" : `Sleep timer, ${choice} minutes`;
}

/** Moon icon with a countdown badge while a timed sleep is running; opens a
 * small menu of the choices. */
export function SleepButton({ className }: { className?: string }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setUntil(typeof player.sleep === "number" ? Date.now() + player.sleep * 60_000 : null);
    setNow(Date.now());
  }, [player.sleep]);
  useEffect(() => {
    if (until === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [until]);
  // ponytail: the countdown starts when this surface sets the timer; a timer
  // set from another surface shows the icon without a badge.
  return (
    <div className={clsx("relative", className)}>
      <button
        type="button"
        aria-label={sleepText(player.sleep)}
        title="Sleep timer"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx(iconButton, "text-fg-2", player.sleep !== null && "text-fg")}
      >
        <Icon name="Moon" size={20} />
        {until !== null && (
          <span className="absolute -top-1 right-0 rounded-sm bg-surface px-1 text-[9px] font-semibold tabular text-fg-2">
            {formatTime(Math.max(0, Math.round((until - now) / 1000)))}
          </span>
        )}
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
            className="absolute right-0 bottom-full z-20 mb-2 w-60 rounded-xl border border-border bg-raised p-1 shadow-(--shadow-menu)"
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
                className="tap flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-base hover:bg-border"
              >
                <span className="w-5 shrink-0">
                  {player.sleep === option.value && <Icon name="Check" size={16} />}
                </span>
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Chapter scrubber with times, for the phone player and the read-along
 * sheet. The elapsed time carries the e2e test id. */
export function ChapterScrubber({ className }: { className?: string }) {
  const player = usePlayer();
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  return (
    <div className={clsx("flex items-center gap-2.5 text-xs tabular text-fg-2", className)}>
      <span data-testid="player-elapsed">{formatTime(elapsed)}</span>
      <input
        type="range"
        aria-label="Position in chapter"
        min={0}
        max={Math.max(total, 1)}
        step={0.1}
        value={elapsed}
        onChange={(event) => player.seekChapter(Number(event.target.value))}
        className="min-w-0 flex-1 accent-accent"
      />
      <span className="whitespace-nowrap">−{formatTime(Math.max(0, total - elapsed))}</span>
    </div>
  );
}
