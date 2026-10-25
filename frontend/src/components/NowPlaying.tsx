/** Phase 3 player surfaces (handoff "Now Playing panel/sheet"): the desktop
 * panel (right 50% column), the collapsed 64px bar and the phone sheet. All
 * three drive the single PlayerProvider state; they are present whenever a
 * book is loaded — never tied to play/pause — and hidden on /player, where
 * FullPlayer takes over. The panel and bar stay mounted while a book is
 * loaded and slide (200 ms, `inert` when off-screen) so collapse/expand
 * animates; reduced motion is instant via the global override in tokens.css. */
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { SPEED_MAX, SPEED_MIN, formatTime, type SleepChoice } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { BookCover } from "./BookCard";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { ReadAlong } from "./ReadAlong";

/** Remembered desktop collapse preference; never switched automatically. */
export const COLLAPSE_KEY = "folio-player-collapsed";

export function usePlayerCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "true");
  const toggle = useCallback(
    () =>
      setCollapsed((current) => {
        localStorage.setItem(COLLAPSE_KEY, String(!current));
        return !current;
      }),
    [],
  );
  return [collapsed, toggle];
}

const iconButton = "tap grid size-9 shrink-0 place-items-center rounded-md text-fg hover:bg-raised";
const quietButton = clsx(iconButton, "text-fg-2");

/** "2 min ago" style relative time for the other-device line. */
function timeAgo(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { style: "short", numeric: "auto" });
  if (seconds < 60) return rtf.format(-Math.round(seconds), "second");
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return rtf.format(-Math.round(seconds / 3600), "hour");
  return rtf.format(-Math.round(seconds / 86_400), "day");
}

function HeaderButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: IconName;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} title={title} onClick={onClick} className={iconButton}>
      <Icon name={icon} size={20} />
    </button>
  );
}

function PlayButton({ size }: { size: 40 | 44 }) {
  const player = usePlayer();
  return (
    <button
      type="button"
      aria-label={player.playing ? "Pause" : "Play"}
      title={player.playing ? "Pause" : "Play"}
      onClick={player.toggle}
      className={clsx(
        "tap grid shrink-0 place-items-center rounded-full bg-primary-gradient text-on-primary",
        size === 40 ? "size-10" : "size-11",
      )}
    >
      <Icon name={player.playing ? "pause" : "play_arrow"} size={size === 40 ? 22 : 20} />
    </button>
  );
}

/** `replay` with the interval drawn inside; mirrored for forward. */
function SkipGlyph({ seconds, forward }: { seconds: number; forward?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-5 items-center justify-center">
      <Icon name="replay" size={20} className={forward ? "-scale-x-100" : undefined} />
      <span className="absolute inset-0 grid place-items-center pt-px text-[8px] font-bold leading-none">{seconds}</span>
    </span>
  );
}

function BackButton({ phone }: { phone?: boolean }) {
  const player = usePlayer();
  return (
    <button
      type="button"
      aria-label={`Back ${player.settings.skip_back} seconds`}
      title={`Back ${player.settings.skip_back} seconds`}
      onClick={player.skipBack}
      className={clsx(iconButton, phone && "size-11")}
    >
      <SkipGlyph seconds={player.settings.skip_back} />
    </button>
  );
}

function ForwardButton({ phone }: { phone?: boolean }) {
  const player = usePlayer();
  return (
    <button
      type="button"
      aria-label={`Forward ${player.settings.skip_forward} seconds`}
      title={`Forward ${player.settings.skip_forward} seconds`}
      onClick={player.skipForward}
      className={clsx(iconButton, phone && "size-11")}
    >
      <SkipGlyph seconds={player.settings.skip_forward} forward />
    </button>
  );
}

function Scrubber() {
  const player = usePlayer();
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  return (
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
  if (choice === null) return "off";
  return choice === "chapter" ? "end of chapter" : `${choice} minutes`;
}

function SleepButton() {
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
  // set elsewhere (focus mode) shows the icon without a badge.
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
        <Icon name="bedtime" size={18} />
        {until !== null && (
          <span className="absolute -top-1 right-0 rounded-sm bg-raised px-1 text-[9px] font-semibold tabular text-fg-2">
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
            className="absolute top-full left-1/2 z-20 mt-2 w-60 -translate-x-1/2 rounded-lg border border-divider bg-surface p-1 shadow-(--shadow-menu)"
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

function OtherDeviceLine({ dense }: { dense?: boolean }) {
  const player = usePlayer();
  if (!player.lastDevice || player.playing) return null;
  return (
    <div
      role="status"
      className={clsx("flex items-center gap-2 rounded-md bg-raised px-2.5 text-fg-2", dense ? "py-1 text-2xs" : "py-2 text-sm")}
    >
      <Icon name="devices" size={18} />
      <span>
        Paused · last played on {player.lastDevice.label} {timeAgo(player.lastDevice.at)}. Resume here to pick up from
        the same spot.
      </span>
    </div>
  );
}

function useChapterLine(): { title: string; line: string } {
  const player = usePlayer();
  const number = player.chapters.findIndex((chapter) => chapter.id === player.chapter?.id) + 1;
  return {
    title: player.chapter?.title ?? "",
    line: `Chapter ${number} · ${player.book?.title ?? ""}`,
  };
}

interface SurfacesProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onFocus: () => void;
}

function Panel({ collapsed, onToggleCollapse, onFocus }: SurfacesProps) {
  const player = usePlayer();
  const book = player.book;
  const chapterLine = useChapterLine();
  if (!book) return null;
  return (
    <aside
      aria-label="Now playing"
      inert={collapsed}
      className={clsx(
        "fixed inset-y-0 right-0 z-10 hidden w-[calc(50vw-30px)] flex-col gap-3 border-l border-divider bg-surface px-5 pt-3.5 pb-3.5 transition-transform duration-200 desktop:flex",
        collapsed && "translate-x-full",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-[0.06em] text-fg-2 uppercase">Now playing</h2>
        <div className="flex items-center gap-0.5">
          <HeaderButton
            icon="keyboard_double_arrow_right"
            label="Collapse player to a bar"
            title="Collapse player (P)"
            onClick={onToggleCollapse}
          />
          <HeaderButton icon="open_in_full" label="Open focus reading mode" title="Focus mode (F)" onClick={onFocus} />
          <HeaderButton icon="close" label="Stop and close player" title="Stop and close player" onClick={player.stop} />
        </div>
      </div>
      <OtherDeviceLine />
      <div className="flex items-center gap-3">
        <BookCover book={book} className="h-[54px] w-9 shrink-0 rounded-sm" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-md font-semibold">{chapterLine.title}</span>
          <span className="truncate text-sm text-fg-2">{chapterLine.line}</span>
        </div>
      </div>
      <Scrubber />
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label={`Playback speed, ${player.rate} times`}
          title="Playback speed"
          onClick={() => player.setRate(player.rate >= SPEED_MAX ? SPEED_MIN : player.rate + 0.25)}
          className={quietButton}
        >
          <Icon name="speed" size={18} />
        </button>
        <button
          type="button"
          aria-label="Previous chapter"
          title="Previous chapter"
          onClick={() => void player.stepChapter(-1)}
          className={iconButton}
        >
          <Icon name="skip_previous" size={20} />
        </button>
        <BackButton />
        <PlayButton size={44} />
        <ForwardButton />
        <button
          type="button"
          aria-label="Next chapter"
          title="Next chapter"
          onClick={() => void player.stepChapter(1)}
          className={iconButton}
        >
          <Icon name="skip_next" size={20} />
        </button>
        <SleepButton />
      </div>
      <ReadAlong compact className="min-h-0 flex-1" />
    </aside>
  );
}

function CollapsedBar({ collapsed, onToggleCollapse }: SurfacesProps) {
  const player = usePlayer();
  const book = player.book;
  const chapterLine = useChapterLine();
  if (!book) return null;
  return (
    <section
      aria-label="Now playing"
      inert={!collapsed}
      className={clsx(
        "fixed inset-x-0 bottom-0 left-[60px] z-10 hidden h-16 items-center gap-5 border-t border-divider bg-surface px-4 transition-transform duration-200 desktop:flex",
        !collapsed && "translate-y-full",
      )}
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        title="Expand player (P)"
        aria-label={`Expand player: ${chapterLine.title}, ${chapterLine.line}`}
        className="-m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 text-left hover:bg-raised"
      >
        <BookCover book={book} className="h-12 w-8 shrink-0 rounded-sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{chapterLine.title}</span>
          <span className="truncate text-xs text-fg-2">{chapterLine.line}</span>
        </span>
      </button>
      <div className="flex flex-[2] items-center gap-3">
        <div className="flex items-center gap-0.5">
          <BackButton />
          <PlayButton size={40} />
          <ForwardButton />
        </div>
        <div className="min-w-0 flex-1">
          <Scrubber />
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <HeaderButton
          icon="keyboard_double_arrow_left"
          label="Expand player"
          title="Expand player (P)"
          onClick={onToggleCollapse}
        />
        <HeaderButton icon="close" label="Stop and close player" title="Stop and close player" onClick={player.stop} />
      </div>
    </section>
  );
}

function Sheet() {
  const player = usePlayer();
  const navigate = useNavigate();
  const book = player.book;
  if (!book) return null;
  const total = player.chapterTotal;
  const elapsed = Math.min(player.chapterElapsed, total);
  const percent = total > 0 ? (elapsed / total) * 100 : 0;
  const open = () => navigate(`/player?book=${book.id}`);
  return (
    <section
      aria-label="Now playing"
      className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 flex flex-col gap-1 rounded-lg bg-surface px-3 pt-1 pb-2 shadow-(--shadow-sheet) desktop:hidden"
    >
      <button type="button" aria-label="Expand player" onClick={open} className="mx-auto flex h-4 w-16 items-center justify-center">
        <span aria-hidden className="h-1 w-10 rounded-xs bg-grabber" />
      </button>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={open}
          aria-label={`Open player: ${player.chapter?.title}, ${book.title}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <BookCover book={book} className="h-[45px] w-[30px] shrink-0 rounded-sm" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold">{player.chapter?.title}</span>
            <span className="truncate text-xs tabular text-fg-2">
              {formatTime(elapsed)} / {formatTime(total)} · {player.rate}×
            </span>
          </span>
        </button>
        <BackButton phone />
        <PlayButton size={44} />
      </div>
      <OtherDeviceLine dense />
      <div aria-hidden className="h-[3px] rounded-xs bg-track">
        <div className="h-full rounded-xs bg-progress" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}

/** The three surfaces; CSS media queries pick panel/bar vs sheet, the
 * remembered `collapsed` flag picks panel vs bar. */
export function PlayerSurfaces({ collapsed, onToggleCollapse, onFocus }: SurfacesProps) {
  const player = usePlayer();
  const location = useLocation();
  if (!player.book || location.pathname === "/player") return null;
  return (
    <>
      <Panel collapsed={collapsed} onToggleCollapse={onToggleCollapse} onFocus={onFocus} />
      <CollapsedBar collapsed={collapsed} onToggleCollapse={onToggleCollapse} onFocus={onFocus} />
      <Sheet />
    </>
  );
}
