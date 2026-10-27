/** Controls shared by every Direction D player surface (player bar, phone
 * mini player, expanded player, phone player and sheet). All of them drive
 * the single PlayerProvider state. */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { SPEED_MAX, SPEED_MIN, SPEED_STEP, formatTime, type SleepChoice } from "../player/PlayerProvider";
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

/** RotateCcw / RotateCw; the accessible name carries the configured seconds. */
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
      <Icon name={direction === "back" ? "RotateCcw" : "RotateCw"} size={22} />
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

/** Speed as a text button opening a slider popover (0.95×–1.25×, step 0.05).
 * The popover anchors right by default; the phone controls pass align="left"
 * so it cannot overflow the viewport edge. */
export function SpeedButton({ className, align = "right" }: { className?: string; align?: "left" | "right" }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    slider.current?.focus();
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
    };
  }, [open]);
  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Playback speed, ${player.rate} times`}
        title="Playback speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx("tap h-10 rounded-full px-2.5 text-base font-semibold text-fg hover:bg-raised", className)}
      >
        {player.rate}×
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Playback speed"
          className={clsx(
            "absolute bottom-full z-20 mb-2 w-56 rounded-xl border border-border bg-raised p-3 shadow-(--shadow-menu)",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-1 text-center text-base font-semibold tabular text-fg">{player.rate}×</div>
          <input
            ref={slider}
            type="range"
            aria-label="Playback speed"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={player.rate}
            onChange={(event) => player.setRate(Number(event.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-xs tabular text-fg-2">
            <span>{SPEED_MIN}×</span>
            <span>{SPEED_MAX}×</span>
          </div>
        </div>
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
