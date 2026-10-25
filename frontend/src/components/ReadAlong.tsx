import clsx from "clsx";

/** Sentence split for the read-along panel; separators collapse to one space. */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/);
  return parts.length > 0 ? parts : [text];
}

/** Screen 6 read-along: the current sentence is estimated by character share
 * of the segment duration (`fraction` = time / duration, 0–1). */
export function ReadAlong({ text, fraction, className }: { text: string; fraction: number; className?: string }) {
  const sentences = splitSentences(text);
  const total = sentences.reduce((chars, sentence) => chars + sentence.length, 0) || 1;
  let acc = 0;
  let active = 0;
  sentences.forEach((sentence, i) => {
    if (acc / total <= fraction) active = i;
    acc += sentence.length;
  });
  return (
    <p className={clsx("rounded-card border border-line bg-card p-4 text-sm leading-relaxed", className)}>
      {sentences.map((sentence, i) => (
        <span
          key={i}
          aria-current={i === active ? "true" : undefined}
          className={i === active ? "rounded bg-brand-tint/30 font-medium text-ink" : "text-muted"}
        >
          {sentence}{" "}
        </span>
      ))}
    </p>
  );
}
