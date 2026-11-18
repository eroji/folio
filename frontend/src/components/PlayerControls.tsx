/** Controls shared by every Direction D player surface (player bar, phone
 * mini player, expanded player, phone player and sheet). All of them drive
 * the single PlayerProvider state. */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
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

/** Where a listening control's panel opens: a popover above its trigger
 * (desktop player bar) or a bottom sheet (phone). */
export type PanelPlacement = "popover" | "sheet";

/** The panel's container. A sheet dims the player behind a scrim and slides
 * up from the bottom edge; a popover sits above its trigger, right-aligned so
 * it never leaves the bar's edge. Escape and outside clicks: useDismiss. */
export function PanelSurface({
  placement,
  role,
  label,
  className,
  onDismiss,
  children,
}: {
  placement: PanelPlacement;
  role?: "dialog" | "menu";
  label?: string;
  className?: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  if (placement === "popover") {
    return (
      <div
        role={role}
        aria-label={label}
        className={clsx(
          "absolute right-0 bottom-full z-20 mb-2 rounded-2xl border border-border bg-raised shadow-(--shadow-menu)",
          className,
        )}
      >
        {children}
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="fixed inset-0 z-40 cursor-default bg-bg/60"
        onClick={onDismiss}
      />
      <div className="sheet-up fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-3 rounded-t-2xl border-t border-border bg-surface px-5 pt-2.5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <span aria-hidden className="h-1 w-9 shrink-0 rounded-full bg-border" />
        <div role={role} aria-label={label} className={clsx("w-full max-w-md", className)}>
          {children}
        </div>
      </div>
    </>
  );
}

/** Escape and clicks outside `container` dismiss an open panel. */
export function useDismiss(open: boolean, onDismiss: () => void, container: RefObject<HTMLElement | null>) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss.current();
    };
    const onClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) dismiss.current();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
    };
  }, [open, container]);
}

/** Classes for a control whose panel is open (amber outline) or that just
 * changed (a short accent glow confirming the new value). */
export function panelTriggerState(open: boolean, flash: boolean): string {
  return clsx(open && "bg-border ring-2 ring-inset ring-accent", flash && !open && "bg-accent/20");
}

/** The speed panel shared by the phone sheet and the desktop popover: the
 * value with a Normal/Slower/Faster hint between minus and plus, above a
 * horizontal slider whose labelled ticks are part of the slider (tapping
 * "1.05" lands on it). The grid comes from config (useSpeedOptions). Changes
 * apply at once; the panel never closes by itself (Done, Escape, outside). */
export function SpeedPanel({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const player = usePlayer();
  const { options } = useSpeedOptions();
  const positions = speedPositions(options);
  const [dragging, setDragging] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const current = snapSpeed(player.rate, options);
  const index = Math.max(0, positions.indexOf(current));
  const fraction = positions.length > 1 ? (current - options.min) / (options.max - options.min) : 0;
  const hint = current === 1 ? "Normal" : current < 1 ? "Slower" : "Faster";

  const step = (next: number) => player.setRate(positions[Math.min(positions.length - 1, Math.max(0, next))]!);

  /** Value at a clientX on the track (left = min), snapped to the grid. */
  function valueFromX(clientX: number): number {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return current;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapSpeed(options.min + ratio * (options.max - options.min), options);
  }
  const dragTo = useRef<(x: number) => void>(() => {});
  dragTo.current = (x: number) => player.setRate(valueFromX(x));

  useEffect(() => {
    track.current?.focus();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => dragTo.current(event.clientX);
    const onUp = () => setDragging(false);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  function onKeyDown(event: ReactKeyboardEvent) {
    const keys: Record<string, number> = {
      ArrowUp: index + 1,
      ArrowRight: index + 1,
      ArrowDown: index - 1,
      ArrowLeft: index - 1,
      PageUp: index + 2,
      PageDown: index - 2,
      Home: 0,
      End: positions.length - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    step(next);
  }

  const percent = (i: number) => (i / Math.max(1, positions.length - 1)) * 100;
  const stepButton = clsx(
    "tap grid shrink-0 place-items-center rounded-full border border-border bg-raised text-fg hover:bg-border disabled:opacity-40",
    compact ? "size-11 bg-surface" : "size-14",
  );
  return (
    <div className="flex flex-col gap-3.5">
      <div className={clsx("flex min-h-9 items-center", onDone ? "justify-between" : "justify-center")}>
        <span className="eyebrow">Playback speed</span>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="tap h-9 rounded-full bg-raised px-3.5 text-base font-semibold text-fg hover:bg-border"
          >
            Done
          </button>
        )}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" aria-label="Slower" disabled={index === 0} onClick={() => step(index - 1)} className={stepButton}>
          <Icon name="Minus" size={compact ? 20 : 22} />
        </button>
        <div className="flex flex-col items-center">
          <span
            data-speed-value
            aria-live="polite"
            className={clsx("font-display leading-none tabular", compact ? "text-[34px]" : "text-[44px]")}
          >
            {formatSpeed(player.rate)}×
          </span>
          <span className="pt-1 text-sm text-fg-2">{hint}</span>
        </div>
        <button
          type="button"
          aria-label="Faster"
          disabled={index === positions.length - 1}
          onClick={() => step(index + 1)}
          className={stepButton}
        >
          <Icon name="Plus" size={compact ? 20 : 22} />
        </button>
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Playback speed"
        aria-orientation="horizontal"
        aria-valuemin={options.min}
        aria-valuemax={options.max}
        aria-valuenow={current}
        aria-valuetext={`${formatSpeed(player.rate)} times`}
        className="relative mx-3 h-14 cursor-pointer touch-none rounded-sm"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
          player.setRate(valueFromX(event.clientX));
        }}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-border" />
        <span
          data-speed-fill
          aria-hidden
          className="absolute top-3 left-0 h-1.5 rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${fraction * 100}%` }}
        />
        {positions.map((value, i) => (
          <span
            key={value}
            data-speed-step
            data-current={value === current ? "true" : undefined}
            aria-hidden
            className={clsx(
              "absolute top-3.5 flex -translate-x-1/2 flex-col items-center gap-3.5 text-sm tabular",
              value === current ? "font-bold text-fg" : "font-medium text-fg-2",
            )}
            style={{ left: `${percent(i)}%` }}
          >
            <span className={clsx("size-1 rounded-full", value <= current ? "bg-bg/55" : "bg-fg-2/60")} />
            {formatSpeed(value)}
          </span>
        ))}
        <span
          data-speed-thumb
          aria-hidden
          className="absolute top-[3px] size-6 -translate-x-1/2 rounded-full bg-fg shadow-[0_0_0_4px_rgb(var(--accent-rgb)/0.35),0_2px_6px_rgb(0_0_0/0.5)] transition-[left] duration-150"
          style={{ left: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Speed alone as a text button opening the speed sheet: the read-along
 * sheet's pinned controls row (the full player uses ListeningControls). */
export function SpeedButton({ className }: { className?: string }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  useDismiss(open, close, wrap);
  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={`Playback speed, ${formatSpeed(player.rate)} times`}
        title="Playback speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={clsx(
          // fixed width + tabular digits: a longer label must not resize the box and shift the row.
          "tap h-10 w-14 shrink-0 rounded-full text-center text-base font-semibold tabular text-fg hover:bg-raised",
          className,
          panelTriggerState(open, false),
        )}
      >
        {formatSpeed(player.rate)}×
      </button>
      {open && (
        <PanelSurface placement="sheet" role="dialog" label="Playback speed" onDismiss={close}>
          <SpeedPanel onDone={close} />
        </PanelSurface>
      )}
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

/** Accessible name of the sleep control for the current choice. */
export function sleepText(choice: SleepChoice): string {
  if (choice === null) return "Sleep timer";
  return choice === "chapter" ? "Sleep timer, end of chapter" : `Sleep timer, ${choice} minutes`;
}

/** Seconds left on a timed sleep set while this surface was mounted; null otherwise. */
export function useSleepCountdown(): number | null {
  const player = usePlayer();
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
  // set from another surface shows its length instead of a countdown.
  return until === null ? null : Math.max(0, Math.round((until - now) / 1000));
}

/** Short value for the sleep control: Off, a running countdown, "30 m", Chapter. */
export function sleepShort(choice: SleepChoice, remaining: number | null): string {
  if (choice === null) return "Off";
  if (choice === "chapter") return "Chapter";
  return remaining !== null ? formatTime(remaining) : `${choice} m`;
}

/** The sleep timer choices (menuitemradio rows); the surface supplies role="menu". */
export function SleepOptions({ onPick, large = false }: { onPick: (choice: SleepChoice) => void; large?: boolean }) {
  const player = usePlayer();
  return (
    <div className="flex flex-col p-1">
      {SLEEP_OPTIONS.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="menuitemradio"
          aria-checked={player.sleep === option.value}
          onClick={() => {
            player.setSleep(option.value);
            onPick(option.value);
          }}
          className={clsx(
            "tap flex w-full items-center gap-2 rounded-lg px-3 text-left hover:bg-border",
            large ? "min-h-11 text-md" : "min-h-9 py-1.5 text-base",
          )}
        >
          <span className="w-5 shrink-0 text-accent">
            {player.sleep === option.value && <Icon name="Check" size={16} />}
          </span>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Chapter scrubber with times, for the phone player and the read-along
 * sheet. The elapsed time carries the e2e test id. */
export function ChapterScrubber({ className }: { className?: string }) {
  const player = usePlayer();
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  const remaining = formatTime(Math.ceil(Math.max(0, total - elapsed)));
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
      {/* Time remaining, like the lock screen (duration − position); "~" while
          part of the chapter is still a character estimate. Rounded up so it
          counts down to 0:00 at the end, as the lock screen does. */}
      <span
        className="whitespace-nowrap"
        data-testid="player-remaining"
        aria-label={`${player.chapterTotalApprox ? "About " : ""}${remaining} remaining in chapter`}
      >
        {player.chapterTotalApprox ? "~" : ""}−{remaining}
      </span>
    </div>
  );
}
