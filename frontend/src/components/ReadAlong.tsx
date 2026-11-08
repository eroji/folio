/** Read-along (handoff "Now playing, expanded"): the chapter as lyrics-style
 * sentences — already-read darker, the current one full white and 4px larger,
 * upcoming lighter. The text scrolls inside its own area (never the window)
 * and keeps the current sentence about a third from the top while auto-scroll
 * is on; a manual scroll pauses the follow and shows "Back to current".
 * Tapping a sentence seeks there. `useReadAlongControls` lifts the text-size
 * and auto-scroll knobs so the phone sheet can drive them from its strip and
 * pinned footer. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { usePlayer, type PlayerContextValue } from "../player/usePlayer";
import { Icon } from "./Icon";

/** Closing quotes/brackets stay with the sentence they end (handoff fix). */
const SENTENCES = /[^.!?。！？…]+[.!?。！？…]*[\u2019\u201D"')\]}»]*/g;

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
 * element's clock directly — the provider's `time` only moves on the
 * throttled (~4 Hz) `timeupdate` and the highlight would lag the audio. */
function spokenChars(p: PlayerContextValue): number {
  const current = p.segments[p.index];
  if (!current) return 0;
  const duration = p.status[current.id]?.duration_s ?? 0;
  const t = p.playing ? p.liveTime() : p.time;
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
const SIZE_KEY = "folio-readalong-size";
/** The five text-size steps (handoff "Text size popover"): read-along body px,
 * picker glyph px, and names. Default is Large; the current sentence is +4px. */
export const TEXT_SIZES = [17, 19, 22, 25, 28];
const SIZE_GLYPHS = [13, 16, 19, 22, 26];
export const SIZE_NAMES = ["Small", "Medium", "Large", "Extra large", "Huge"];
export const DEFAULT_SIZE_STEP = 2;
const CURRENT_BUMP_PX = 4;

export interface ReadAlongControls {
  autoScroll: boolean;
  setAutoScroll: (value: boolean) => void;
  sizeStep: number;
  setSizeStep: (step: number) => void;
}

export function useReadAlongControls(): ReadAlongControls {
  const [autoScroll, setAutoScroll] = useState(true);
  const [sizeStep, setStep] = useState(() => {
    const raw = localStorage.getItem(SIZE_KEY);
    const stored = raw === null ? NaN : Number(raw);
    const valid = Number.isInteger(stored) && stored >= 0 && stored < TEXT_SIZES.length;
    return valid ? stored : DEFAULT_SIZE_STEP;
  });
  const setSizeStep = useCallback((step: number) => {
    localStorage.setItem(SIZE_KEY, String(step));
    setStep(step);
  }, []);
  return { autoScroll, setAutoScroll, sizeStep, setSizeStep };
}

/** The "Aa" pill with the text-size popover below it (handoff
 * reference/desktop-player-text-size.html). */
export function TextSizePicker({ step, onStep }: { step: number; onStep: (step: number) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
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
    <span ref={wrap} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="Text size"
        title="Text size"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          "tap h-9 rounded-full border px-3.5 font-display text-[15px] leading-none text-fg",
          open ? "border-fg bg-raised" : "border-border hover:bg-raised",
        )}
      >
        Aa
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Text size"
          className="absolute top-[46px] right-0 z-20 flex w-[300px] flex-col gap-3 rounded-2xl border border-border bg-raised p-4 shadow-(--shadow-menu)"
        >
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-bold text-fg">Text size</span>
            <span className="text-[13px] text-fg-2">{SIZE_NAMES[step]}</span>
          </div>
          <div role="radiogroup" aria-label="Text size" className="flex items-center justify-between rounded-full border border-border bg-bg p-1">
            {SIZE_GLYPHS.map((glyph, i) => (
              <button
                key={glyph}
                type="button"
                role="radio"
                aria-checked={i === step}
                aria-label={SIZE_NAMES[i]}
                onClick={() => {
                  onStep(i);
                  setOpen(false);
                }}
                style={{ fontSize: glyph }}
                className={clsx(
                  "tap grid h-11 w-12 place-items-center rounded-full font-bold leading-none",
                  i === step ? "bg-fg text-on-fg" : "text-fg hover:bg-border",
                )}
              >
                A
              </button>
            ))}
          </div>
          <span className="text-xs text-fg-2">Used for read along in every book.</span>
        </div>
      )}
    </span>
  );
}

/** 36px round auto-scroll toggle: accent fill when on, outlined when off. */
export function AutoScrollToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      aria-label="Auto-scroll"
      title={`Auto-scroll: ${value ? "on" : "off"}`}
      aria-pressed={value}
      onClick={() => onChange(!value)}
      className={clsx(
        "tap grid size-9 shrink-0 place-items-center rounded-full",
        value ? "bg-accent text-on-fg" : "border border-border text-fg hover:bg-raised",
      )}
    >
      <Icon name="ChevronsDown" size={20} />
    </button>
  );
}

export function ReadAlong({
  className,
  phone = false,
  toolbar = true,
  controls,
}: {
  className?: string;
  /** Phone sheet: same five steps, faded edges. */
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

  const base = TEXT_SIZES[c.sizeStep] ?? TEXT_SIZES[DEFAULT_SIZE_STEP]!;

  return (
    <div className={clsx("relative mx-auto flex min-h-0 w-full max-w-[620px] flex-col", className)}>
      {toolbar && (
        <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
          <span className="text-sm text-fg-2">Follows the narration</span>
          <div className="flex items-center gap-2">
            <TextSizePicker step={c.sizeStep} onStep={c.setSizeStep} />
            <AutoScrollToggle value={c.autoScroll} onChange={c.setAutoScroll} />
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
        data-size-step={c.sizeStep}
        className={clsx(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          phone ? "no-scrollbar" : "scroll-thin",
          phone && "fade-edges",
          manual ? "pb-16" : "pb-12", // breathing room above the player bar / the pill
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
              style={i === active ? { fontSize: base + CURRENT_BUMP_PX } : undefined}
              onClick={() => tapSentence(sentence)}
              className={clsx("m-0 cursor-pointer", i < active ? "ra-past" : i === active ? "ra-current" : "ra-next")}
            >
              {sentence.text}
            </p>
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {activeSentence?.text}
        </p>
      </article>
      {/* Outside the scroller: sticky inside it clipped against the player bar. */}
      {manual && c.autoScroll && (
        <button
          type="button"
          onClick={() => {
            setManual(false);
            jumpTo.current?.();
          }}
          className="tap absolute bottom-3 left-1/2 z-10 h-9 w-32 -translate-x-1/2 rounded-full bg-raised text-sm font-semibold text-fg shadow-(--shadow-menu) hover:bg-border"
        >
          Back to current
        </button>
      )}
    </div>
  );
}
