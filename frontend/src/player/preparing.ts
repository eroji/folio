/** The "Preparing audio…" line, with the awaited segment's sentence count
 * once the worker reports it ("Preparing audio… 4 of 11 sentences"). */
export function preparingText(progress: { done: number; total: number } | null): string {
  return progress && progress.total > 1
    ? `Preparing audio… ${progress.done} of ${progress.total} sentences`
    : "Preparing audio…";
}

/** Whole percent of the awaited segment synthesized, or null before any report. */
export function preparingPercent(progress: { done: number; total: number } | null): number | null {
  return progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
}
