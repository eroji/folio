import { useEffect, useMemo, useRef, useState } from "react";
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
const FONT_KEY = "folio-readalong-font";
/** A− / A+ steps applied to the base clamp(); two steps up from the default. */
const FONT_SCALES = [1, 1.15, 1.3];

function readFontStep(): number {
  const stored = Number(localStorage.getItem(FONT_KEY));
  return Number.isInteger(stored) && stored >= 0 && stored < FONT_SCALES.length ? stored : 0;
}

/** Read-along: the whole chapter as ebook-styled paragraphs, the spoken
 * sentence highlighted with a tint + left rule (position = segment index +
 * time/duration share mapped through char_start/char_end), auto-centered,
 * tap-to-seek, A−/A+ font steps persisted in localStorage. */
export function ReadAlong({ className }: { className?: string }) {
  const player = usePlayer();
  const panel = useRef<HTMLDivElement>(null);
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
  // Scrolls the panel only — the window must never jump.
  useEffect(() => {
    if (!player.playing) return;
    const now = Date.now();
    if (now < manualUntil.current || now - lastScroll.current < SCROLL_MS) return;
    const box = panel.current;
    const node = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !node) return;
    lastScroll.current = now;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo?.({ top: node.offsetTop - box.clientHeight / 2, behavior: reduced ? "auto" : "smooth" });
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

  const [step, setStep] = useState(readFontStep);
  const changeFont = (delta: number) =>
    setStep((current) => {
      const next = Math.min(FONT_SCALES.length - 1, Math.max(0, current + delta));
      localStorage.setItem(FONT_KEY, String(next));
      return next;
    });

  return (
    <div className={clsx("mx-auto w-full max-w-[68ch]", className)}>
      <div
        ref={panel}
        onWheel={markManual}
        onTouchMove={markManual}
        onKeyDown={markManual}
        className="reader-scroll relative max-h-[calc(100dvh-20rem)] overflow-y-auto rounded-card border border-line bg-paper px-8 pb-8 md:px-10 md:pb-10"
      >
        <div className="sticky top-0 z-10 -mx-8 mb-2 flex justify-end gap-1 bg-paper/95 px-8 pb-2 pt-8 backdrop-blur md:-mx-10 md:px-10 md:pt-10">
          <button
            type="button"
            aria-label="Decrease font size"
            disabled={step === 0}
            onClick={() => changeFont(-1)}
            className="grid h-11 w-11 place-items-center rounded-pill border border-line bg-card text-sm font-medium disabled:opacity-40"
          >
            A−
          </button>
          <button
            type="button"
            aria-label="Increase font size"
            disabled={step === FONT_SCALES.length - 1}
            onClick={() => changeFont(1)}
            className="grid h-11 w-11 place-items-center rounded-pill border border-line bg-card text-sm font-medium disabled:opacity-40"
          >
            A+
          </button>
        </div>
        <div
          data-font-step={step}
          aria-live="off"
          style={{ fontSize: `calc(clamp(1.05rem, 0.7rem + 1.2vw, 1.35rem) * ${FONT_SCALES[step]})`, lineHeight: 1.75 }}
          className="font-reading text-ink [text-wrap:pretty]"
        >
          {groups.map((group) => (
            <p key={group.segment.id} className="mb-[0.85em] last:mb-0">
              {group.sentences.map((sentence) => (
                <span
                  key={sentence.start}
                  aria-current={sentence === activeSentence ? "true" : undefined}
                  onClick={() => tapSentence(sentence)}
                  className={clsx(
                    "cursor-pointer rounded-r py-px",
                    sentence === activeSentence &&
                      "bg-brand-violet/15 shadow-[inset_2px_0_0_var(--color-brand-violet)]",
                  )}
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
      </div>
    </div>
  );
}
