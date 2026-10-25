/** Read-along (handoff "Now playing, expanded"): the chapter as lyrics-style
 * sentences — past at 38% white, the current one full white and larger,
 * upcoming at 62%. The text scrolls inside its own area (never the window)
 * and keeps the current sentence about a third from the top while auto-scroll
 * is on; a manual scroll pauses the follow and shows "Back to current".
 * Tapping a sentence seeks there. `useReadAlongControls` lifts the text-size
 * and auto-scroll knobs so the phone sheet can drive them from its strip and
 * pinned footer. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { usePlayer } from "../player/usePlayer";
import { Icon } from "./Icon";

const SENTENCES = /[^.!?。！？…]+[.!?。！？…]*/g;

/** Sentence split for the read-along; handles punctuation without a trailing
 * space (CJK "。" / "！"). */
export function splitSentences(text: string): string[] {
  return text.match(SENTENCES)?.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0) ?? [text];
}

interface Sentence {
  text: string;
  /** Character offset in the chapter. */
  start: number;
  segmentIdx: number;
}

const SCROLL_MS = 250; // auto-scroll target refresh throttle
const SCROLL_ANIM_MS = 300; // ease-out animation toward the target
const FONT_KEY = "folio-readalong-font";
/** Text-size button steps applied to 22/26 px (phone 21/25). */
const FONT_SCALES = [1, 1.15, 1.3];

export interface ReadAlongControls {
  autoScroll: boolean;
  setAutoScroll: (value: boolean) => void;
  fontStep: number;
  cycleFont: () => void;
}

export function useReadAlongControls(): ReadAlongControls {
  const [autoScroll, setAutoScroll] = useState(true);
  const [fontStep, setFontStep] = useState(() => {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return Number.isInteger(stored) && stored >= 0 && stored < FONT_SCALES.length ? stored : 0;
  });
  const cycleFont = useCallback(
    () =>
      setFontStep((current) => {
        const next = (current + 1) % FONT_SCALES.length;
        localStorage.setItem(FONT_KEY, String(next));
        return next;
      }),
    [],
  );
  return { autoScroll, setAutoScroll, fontStep, cycleFont };
}

export function ReadAlong({
  className,
  phone = false,
  toolbar = true,
  controls,
}: {
  className?: string;
  /** Phone sheet sizes: 21 / 25 px and faded edges. */
  phone?: boolean;
  /** Render the "Follows the narration" row (the sheet drives it externally). */
  toolbar?: boolean;
  controls?: ReadAlongControls;
}) {
  const player = usePlayer();
  const own = useReadAlongControls();
  const c = controls ?? own;
  const panel = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const animation = useRef<number | null>(null);
  const jumpTo = useRef<(() => void) | null>(null);

  const all = useMemo(
    () =>
      player.segments.flatMap((segment, segmentIdx) => {
        let local = 0;
        return splitSentences(segment.text).map((text) => {
          const sentence: Sentence = { text, start: segment.char_start + local, segmentIdx };
          local += text.length; // ponytail: separators are dropped, ±1 char drift is fine for highlighting
          return sentence;
        });
      }),
    [player.segments],
  );

  const current = player.segments[player.index];
  const duration = current ? player.status[current.id]?.duration_s ?? 0 : 0;
  const share = duration > 0 ? Math.min(1, player.time / duration) : 0;
  const spoken = current ? current.char_start + share * Math.max(0, current.char_end - current.char_start) : 0;
  let active = 0;
  for (let i = 0; i < all.length; i += 1) {
    if ((all[i]?.start ?? 0) <= spoken) active = i;
    else break;
  }
  const activeSentence: Sentence | undefined = all[active];

  function scrollToCurrent() {
    const box = panel.current;
    const node = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !node) return;
    stopAnimation();
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = box.scrollTop;
    const to = Math.max(0, node.offsetTop - box.clientHeight / 3); // current ~1/3 from the top
    if (reduced || from === to) {
      box.scrollTop = to;
      return;
    }
    let start: number | null = null;
    const frame = (time: number) => {
      start ??= time;
      const t = Math.min(1, (time - start) / SCROLL_ANIM_MS);
      box.scrollTop = from + (to - from) * (1 - (1 - t) * (1 - t)); // ease-out quad
      animation.current = t < 1 ? requestAnimationFrame(frame) : null;
    };
    animation.current = requestAnimationFrame(frame);
  }
  jumpTo.current = scrollToCurrent;

  // Runs on every render (timeupdate bumps it); the throttle refreshes the
  // target ≤ 4/s. Scrolls the panel only — never the window.
  useEffect(() => {
    if (!player.playing || !c.autoScroll || manual) return;
    const now = Date.now();
    if (now - lastScroll.current < SCROLL_MS) return;
    lastScroll.current = now;
    scrollToCurrent();
  });

  useEffect(() => stopAnimation, []);

  function stopAnimation() {
    if (animation.current !== null) {
      cancelAnimationFrame(animation.current);
      animation.current = null;
    }
  }

  // A manual scroll pauses the follow until "Back to current" (or the
  // auto-scroll toggle is clicked off and on again).
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (c.autoScroll) setManual(false);
  }, [c.autoScroll]);
  const markManual = () => {
    if (!c.autoScroll) return;
    stopAnimation();
    setManual(true);
  };

  const tapSentence = (sentence: Sentence) => {
    const segment = player.segments[sentence.segmentIdx];
    if (!segment) return;
    const span = Math.max(1, segment.char_end - segment.char_start);
    const seconds = player.status[segment.id]?.duration_s ?? 0;
    player.seekSegment(sentence.segmentIdx, ((sentence.start - segment.char_start) / span) * seconds);
  };

  const scale = FONT_SCALES[c.fontStep] ?? 1;
  const base = (phone ? 21 : 22) * scale;
  const currentSize = (phone ? 25 : 26) * scale;

  return (
    <div className={clsx("relative mx-auto flex min-h-0 w-full max-w-[68ch] flex-col", className)}>
      {toolbar && (
        <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
          <span className="text-sm text-fg-2">Follows the narration</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Text size"
              title="Text size"
              onClick={c.cycleFont}
              className="tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised"
            >
              <Icon name="AlignLeft" size={18} />
            </button>
            <button
              type="button"
              aria-pressed={c.autoScroll}
              onClick={() => c.setAutoScroll(!c.autoScroll)}
              className="tap h-9 rounded-full bg-raised px-3.5 text-sm font-semibold text-fg hover:bg-border"
            >
              Auto-scroll {c.autoScroll ? "on" : "off"}
            </button>
          </div>
        </div>
      )}
      <article
        ref={panel}
        onWheel={markManual}
        onTouchMove={markManual}
        onKeyDown={markManual}
        lang={player.book?.language}
        aria-label="Read along"
        data-font-step={c.fontStep}
        className={clsx(
          "no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain",
          phone && "fade-edges",
        )}
      >
        <div
          aria-live="off"
          style={{ fontSize: base, lineHeight: 1.55, fontWeight: 600, letterSpacing: "-0.01em" }}
          className="flex flex-col gap-[1em] font-ui text-fg [text-wrap:pretty]"
        >
          {all.length === 0 && <p className="text-md font-medium text-fg-2">Nothing to read along yet.</p>}
          {all.map((sentence, i) => (
            <p
              key={`${sentence.start}-${sentence.segmentIdx}`}
              aria-current={i === active ? "true" : undefined}
              onClick={() => tapSentence(sentence)}
              style={i === active ? { fontSize: currentSize } : undefined}
              className={clsx("m-0 cursor-pointer", i < active ? "ra-past" : i === active ? "ra-current" : "ra-next")}
            >
              {sentence.text}
            </p>
          ))}
        </div>
        {manual && c.autoScroll && (
          <button
            type="button"
            onClick={() => {
              setManual(false);
              jumpTo.current?.();
            }}
            className="tap sticky bottom-3 left-1/2 z-10 -ml-[64px] h-9 w-32 rounded-full bg-raised text-sm font-semibold text-fg shadow-(--shadow-menu) hover:bg-border"
          >
            Back to current
          </button>
        )}
        <p className="sr-only" aria-live="polite">
          {activeSentence?.text}
        </p>
      </article>
    </div>
  );
}
