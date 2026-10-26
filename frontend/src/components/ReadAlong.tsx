/** Read-along (handoff "Now playing, expanded"): the chapter as lyrics-style
 * sentences — past at 38% white, the current one full white and larger,
 * upcoming at 62%. The text scrolls inside its own area (never the window)
 * and keeps the current sentence about a third from the top while auto-scroll
 * is on; a manual scroll pauses the follow and shows "Back to current".
 * Tapping a sentence seeks there. `useReadAlongControls` lifts the text-size
 * and auto-scroll knobs so the phone sheet can drive them from its strip and
 * pinned footer. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { usePlayer, type PlayerContextValue } from "../player/usePlayer";
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

/** Characters spoken at the current position. While playing this measures the
 * active element's clock directly — the provider's `time` only moves on the
 * throttled (~4 Hz) `timeupdate` and the highlight would lag the audio. */
function spokenChars(p: PlayerContextValue): number {
  const current = p.segments[p.index];
  if (!current) return 0;
  const duration = p.status[current.id]?.duration_s ?? 0;
  const t = p.playing ? p.elements[p.active]?.currentTime ?? p.time : p.time;
  const share = duration > 0 ? Math.min(1, t / duration) : 0;
  return current.char_start + share * Math.max(0, current.char_end - current.char_start);
}

/** Index of the sentence being spoken at character offset `spoken`. */
function activeSentenceIndex(all: Sentence[], spoken: number): number {
  let i = 0;
  for (let j = 0; j < all.length; j += 1) {
    if ((all[j]?.start ?? 0) <= spoken) i = j;
    else break;
  }
  return i;
}

const SCROLL_ANIM_MS = 300; // ease-out animation toward the target
const FONT_KEY = "folio-readalong-font";
/** Text-size button steps applied to 22/26 px (phone 21/25). */
const FONT_SCALES = [1, 1.15, 1.3];

export interface ReadAlongControls {
  autoScroll: boolean;
  setAutoScroll: (value: boolean) => void;
  fontStep: number;
  decFont: () => void;
  incFont: () => void;
}

export function useReadAlongControls(): ReadAlongControls {
  const [autoScroll, setAutoScroll] = useState(true);
  const [fontStep, setFontStep] = useState(() => {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return Number.isInteger(stored) && stored >= 0 && stored < FONT_SCALES.length ? stored : 0;
  });
  const stepFont = useCallback(
    (delta: number) =>
      setFontStep((current) => {
        const next = Math.max(0, Math.min(FONT_SCALES.length - 1, current + delta));
        localStorage.setItem(FONT_KEY, String(next));
        return next;
      }),
    [],
  );
  return {
    autoScroll,
    setAutoScroll,
    fontStep,
    decFont: () => stepFont(-1),
    incFont: () => stepFont(1),
  };
}

/** The A− / A+ pair used by the read-along toolbar and the phone sheet strip. */
export function FontSizeButtons({ controls }: { controls: ReadAlongControls }) {
  const step = ` (size ${controls.fontStep + 1} of ${FONT_SCALES.length})`;
  const button = "tap grid size-9 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised disabled:opacity-40";
  return (
    <>
      <button
        type="button"
        aria-label={`Decrease font size${step}`}
        title="Decrease font size"
        onClick={controls.decFont}
        disabled={controls.fontStep === 0}
        className={button}
      >
        <Icon name="TextDecrease" size={18} />
      </button>
      <button
        type="button"
        aria-label={`Increase font size${step}`}
        title="Increase font size"
        onClick={controls.incFont}
        disabled={controls.fontStep === FONT_SCALES.length - 1}
        className={button}
      >
        <Icon name="TextIncrease" size={18} />
      </button>
    </>
  );
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
  const animation = useRef<number | null>(null);
  const jumpTo = useRef<(() => void) | null>(null);
  const playerRef = useRef(player);
  const allRef = useRef<Sentence[]>([]);
  const activeRef = useRef(0);
  const [, setActiveTick] = useState(0);

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

  playerRef.current = player;
  allRef.current = all;
  // While playing this reads the live element clock (see spokenChars), so a
  // render — from any source — always shows the sentence being spoken now.
  const active = activeSentenceIndex(all, spokenChars(player));
  activeRef.current = active;
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

  // While playing, measure the audio clock at rAF cadence. A re-render (and
  // with it the scroll animation in the layout effect below) happens only
  // when the sentence actually changes — never every frame, and never toward
  // the stale timeupdate snapshot. The loop stops on pause/end/unmount.
  useEffect(() => {
    if (!player.playing) return;
    let raf = requestAnimationFrame(function step() {
      const next = activeSentenceIndex(allRef.current, spokenChars(playerRef.current));
      if (next !== activeRef.current) setActiveTick((n) => n + 1);
      raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [player.playing]);

  // A manual scroll pauses the follow until "Back to current" (or the
  // auto-scroll toggle is clicked off and on again).
  const [manual, setManual] = useState(false);

  // The follow: place the current sentence on mount, whenever the segment,
  // chapter or book changes, and whenever the spoken sentence changes while
  // playing — without requiring an auto-scroll toggle. useLayoutEffect runs
  // after the new aria-current has been committed, so the geometry is right.
  useLayoutEffect(() => {
    if (!c.autoScroll || manual) return;
    scrollToCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollToCurrent reads live geometry from the DOM and refs
  }, [player.book?.id, player.chapter?.id, player.index, active, all.length, c.autoScroll, manual]);

  useEffect(() => stopAnimation, []);

  function stopAnimation() {
    if (animation.current !== null) {
      cancelAnimationFrame(animation.current);
      animation.current = null;
    }
  }

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
    <div className={clsx("relative mx-auto flex min-h-0 w-full max-w-[620px] flex-col", className)}>
      {toolbar && (
        <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
          <span className="text-sm text-fg-2">Follows the narration</span>
          <div className="flex items-center gap-1.5">
            <FontSizeButtons controls={c} />
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
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          phone ? "no-scrollbar" : "scroll-thin",
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
