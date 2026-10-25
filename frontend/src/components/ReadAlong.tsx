import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { usePlayer } from "../player/usePlayer";

const SENTENCES = /[^.!?。！？…]+[.!?。！？…]*/g;

/** Sentence split for the read-along panel; handles punctuation without a
 * trailing space (CJK "。" / "！"). */
export function splitSentences(text: string): string[] {
  return text.match(SENTENCES)?.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0) ?? [text];
}

interface Sentence {
  text: string;
  /** Character offset in the chapter. */
  start: number;
  segmentIdx: number;
}

const SCROLL_MS = 250; // auto-scroll throttle
const MANUAL_MS = 5000; // auto-scroll pause after the user scrolls

/** Read-along panel: the whole chapter as paragraphs, the spoken sentence
 * highlighted (position = segment index + time/duration share mapped through
 * char_start/char_end), auto-centered, tap-to-seek. */
export function ReadAlong({ className }: { className?: string }) {
  const player = usePlayer();
  const box = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const manualUntil = useRef(0);

  const groups = useMemo(
    () =>
      player.segments.map((segment, segmentIdx) => {
        let local = 0;
        const sentences: Sentence[] = splitSentences(segment.text).map((text) => {
          const sentence: Sentence = { text, start: segment.char_start + local, segmentIdx };
          local += text.length; // ponytail: separators are dropped, ±1 char drift is fine for highlighting
          return sentence;
        });
        return { segment, segmentIdx, sentences };
      }),
    [player.segments],
  );
  const all = useMemo(() => groups.flatMap((group) => group.sentences), [groups]);

  const current = player.segments[player.index];
  const duration = current ? player.status[current.id]?.duration_s ?? 0 : 0;
  const share = duration > 0 ? Math.min(1, player.time / duration) : 0;
  const spoken = current
    ? current.char_start + share * Math.max(0, current.char_end - current.char_start)
    : 0;
  let active = 0;
  for (let i = 0; i < all.length; i += 1) {
    if ((all[i]?.start ?? 0) <= spoken) active = i;
    else break;
  }
  const activeSentence: Sentence | undefined = all[active];

  // Runs on every render (timeupdate bumps it); the throttle keeps scrolling ≤ 4/s.
  useEffect(() => {
    if (!player.playing) return;
    const now = Date.now();
    if (now < manualUntil.current || now - lastScroll.current < SCROLL_MS) return;
    const node = box.current?.querySelector('[aria-current="true"]');
    if (!node) return;
    lastScroll.current = now;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
  });

  const markManual = () => {
    manualUntil.current = Date.now() + MANUAL_MS;
  };

  const tapSentence = (sentence: Sentence) => {
    const segment = player.segments[sentence.segmentIdx];
    if (!segment) return;
    const span = Math.max(1, segment.char_end - segment.char_start);
    const seconds = player.status[segment.id]?.duration_s ?? 0;
    player.seekSegment(sentence.segmentIdx, ((sentence.start - segment.char_start) / span) * seconds);
  };

  return (
    <div
      ref={box}
      aria-live="off"
      onWheel={markManual}
      onTouchMove={markManual}
      onKeyDown={markManual}
      className={clsx(
        "max-h-[40dvh] overflow-y-auto rounded-card border border-line bg-card px-4 py-3 text-sm leading-relaxed",
        className,
      )}
    >
      {groups.map((group) => (
        <p
          key={group.segment.id}
          className={clsx("mb-3 rounded px-1 last:mb-0", group.segmentIdx === player.index && "bg-brand-tint/20")}
        >
          {group.sentences.map((sentence) => (
            <span
              key={sentence.start}
              aria-current={sentence === activeSentence ? "true" : undefined}
              onClick={() => tapSentence(sentence)}
              className={clsx("cursor-pointer", sentence === activeSentence ? "font-medium text-ink" : "text-muted")}
            >
              {sentence.text}{" "}
            </span>
          ))}
        </p>
      ))}
      <p className="sr-only" aria-live="polite">
        {activeSentence?.text}
      </p>
    </div>
  );
}
