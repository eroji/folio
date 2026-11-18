/** Speed, narrator and sleep timer as one control group (design "C"):
 * - layout "card" (phone player): a raised card of three equal cells, value
 *   over a small label; each cell opens a bottom sheet.
 * - layout "bar" (desktop player bar): one segmented pill; each segment opens
 *   a popover above the bar, right-aligned.
 * The open control keeps an amber outline; after its panel closes it glows
 * briefly with the new value. Panels never close by themselves: Done (phone
 * speed), Escape, an outside click, or the control again. Listeners who can't
 * edit the book see the narrator as display-only text. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useBook } from "../api/books";
import type { Book } from "../api/types";
import { formatSpeed } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { Icon } from "./Icon";
import { useChangeNarrator, useNarrator } from "./NarratorControl";
import { NarratorVoiceDialog } from "./NarratorVoiceDialog";
import {
  PanelSurface,
  SleepOptions,
  SpeedPanel,
  panelTriggerState,
  sleepShort,
  sleepText,
  useDismiss,
  useSleepCountdown,
} from "./PlayerControls";

type Panel = "speed" | "voice" | "sleep";
type Layout = "card" | "bar";

/** How long a control glows after its panel closes. */
const FLASH_MS = 900;

export function ListeningControls({ layout }: { layout: Layout }) {
  const player = usePlayer();
  // Read the book through its query so a narrator change shows at once (and
  // so the voice reload finds the cached book).
  const { data } = useBook(player.book?.id ?? "");
  const book = data?.book ?? player.book;
  if (!book) return null;
  return <Controls book={book} layout={layout} />;
}

function Controls({ book, layout }: { book: Book; layout: Layout }) {
  const player = usePlayer();
  const placement = layout === "card" ? "sheet" : "popover";
  const [open, setOpen] = useState<Panel | null>(null);
  const [flash, setFlash] = useState<Panel | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<Panel, HTMLButtonElement>());
  const flashTimer = useRef<number | null>(null);
  const { label: voiceName } = useNarrator(book);
  const narrator = useChangeNarrator(book);
  const remaining = useSleepCountdown();
  const canChangeVoice = book.can_edit ?? false;

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  function close(which: Panel) {
    setOpen(null);
    setFlash(which);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    triggers.current.get(which)?.focus();
  }
  function toggle(which: Panel) {
    if (open === which) close(which);
    else {
      setFlash(null);
      setOpen(which);
    }
  }
  useDismiss(open !== null, () => open && close(open), wrap);

  const trigger = (which: Panel) => ({
    ref: (node: HTMLButtonElement | null) => {
      if (node) triggers.current.set(which, node);
      else triggers.current.delete(which);
    },
    "aria-expanded": open === which,
    "data-flash": flash === which ? "true" : undefined,
    onClick: () => toggle(which),
  });

  const speedValue = `${formatSpeed(player.rate)}×`;
  const voiceValue = voiceName ?? "Default";
  const sleepValue = sleepShort(player.sleep, remaining);

  const cells: { key: Panel; label: string; value: ReactNode; aria: string; title: string; popup: "dialog" | "menu"; static?: boolean }[] = [
    { key: "speed", label: "Speed", value: speedValue, aria: `Playback speed, ${formatSpeed(player.rate)} times`, title: "Playback speed", popup: "dialog" },
    {
      key: "voice",
      label: "Narrator",
      value: (
        <>
          <Icon name="Speech" size={layout === "card" ? 18 : 17} className="shrink-0" />
          <span className="min-w-0 truncate">{voiceValue}</span>
        </>
      ),
      aria: `Narrator voice, ${voiceValue}`,
      title: "Narrator voice",
      popup: "dialog",
      static: !canChangeVoice,
    },
    {
      key: "sleep",
      label: "Sleep",
      value: (
        <>
          <Icon name="Moon" size={layout === "card" ? 18 : 17} className="shrink-0" />
          <span className="tabular">{sleepValue}</span>
        </>
      ),
      aria: sleepText(player.sleep),
      title: "Sleep timer",
      popup: "menu",
    },
  ];

  const cellClass = (which: Panel, isStatic: boolean) =>
    clsx(
      "flex min-w-0 items-center text-fg transition-colors duration-500",
      layout === "card"
        ? "h-16 flex-col justify-center gap-0.5 rounded-2xl px-2"
        : clsx("h-11 gap-1.5 rounded-full text-base font-semibold", which === "speed" ? "w-14 justify-center text-center tabular" : "max-w-[160px] px-3.5"),
      !isStatic && "tap hover:bg-border",
      panelTriggerState(open === which, flash === which),
    );

  const cellContent = (cell: (typeof cells)[number]) =>
    layout === "card" ? (
      <>
        <span className="flex max-w-full min-w-0 items-center gap-1.5 text-md leading-[22px] font-bold">{cell.value}</span>
        <span className="text-2xs font-semibold tracking-[0.08em] text-fg-2 uppercase">{cell.label}</span>
      </>
    ) : (
      cell.value
    );

  return (
    <div ref={wrap} className={clsx("relative", layout === "bar" && "shrink-0")}>
      <div
        role="group"
        aria-label="Listening"
        className={clsx(
          "bg-raised",
          layout === "card"
            ? "grid grid-cols-3 divide-x divide-border rounded-2xl"
            : "flex h-11 items-center rounded-full",
        )}
      >
        {cells.map((cell, index) => (
          <div key={cell.key} className={clsx("flex min-w-0 items-center", layout === "card" ? "justify-center" : "contents")}>
            {layout === "bar" && index > 0 && <span aria-hidden className="h-5 w-px shrink-0 bg-border" />}
            {cell.static ? (
              <span title={cell.title} className={clsx(cellClass(cell.key, true), layout === "card" && "w-full")}>
                <span className="sr-only">Narrator: </span>
                {cellContent(cell)}
              </span>
            ) : (
              <button
                type="button"
                aria-label={cell.aria}
                title={cell.title}
                aria-haspopup={cell.popup}
                {...trigger(cell.key)}
                className={clsx(cellClass(cell.key, false), layout === "card" && "w-full")}
              >
                {cellContent(cell)}
              </button>
            )}
          </div>
        ))}
      </div>

      {open === "speed" && (
        <PanelSurface
          placement={placement}
          role="dialog"
          label="Playback speed"
          className={placement === "popover" ? "w-[340px] px-5 pt-4 pb-3" : undefined}
          onDismiss={() => close("speed")}
        >
          <SpeedPanel compact={placement === "popover"} onDone={placement === "sheet" ? () => close("speed") : undefined} />
        </PanelSurface>
      )}
      {open === "voice" &&
        (placement === "popover" ? (
          <NarratorVoiceDialog
            variant="popover"
            value={book.narrator_voice}
            language={book.language}
            error={narrator.error}
            onClose={() => close("voice")}
            onSelect={narrator.select}
          />
        ) : (
          <PanelSurface placement="sheet" onDismiss={() => close("voice")}>
            <NarratorVoiceDialog
              variant="sheet"
              value={book.narrator_voice}
              language={book.language}
              error={narrator.error}
              onClose={() => close("voice")}
              onSelect={narrator.select}
            />
          </PanelSurface>
        ))}
      {open === "sleep" && (
        <PanelSurface
          placement={placement}
          role="menu"
          label="Sleep timer"
          className={placement === "popover" ? "w-60 p-1" : undefined}
          onDismiss={() => close("sleep")}
        >
          <SleepOptions large={placement === "sheet"} onPick={() => close("sleep")} />
        </PanelSurface>
      )}
    </div>
  );
}
