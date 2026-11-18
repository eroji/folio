/** Sentence marks of a clip: where each TTS request (one sentence) starts.
 * Every sentence is its own request and the server records `[fraction of the
 * segment's text, seconds into the clip]` for each, so read-along can follow
 * the narration instead of assuming an even pace. Clips made as one request
 * have no marks and fall back to the even spread. */
export type Marks = [number, number][];

function bounds(marks: Marks, duration: number, index: number): [number, number, number, number] {
  const [fraction, seconds] = marks[index]!;
  const next = marks[index + 1];
  return [fraction, seconds, next ? next[0] : 1, next ? next[1] : duration];
}

/** Share of the segment's text spoken `t` seconds into its clip (0..1). */
export function spokenFraction(t: number, duration: number, marks?: Marks | null): number {
  if (!(duration > 0)) return 0;
  const clamped = Math.min(duration, Math.max(0, t));
  if (!marks || marks.length < 2) return clamped / duration;
  let index = 0;
  while (index + 1 < marks.length && marks[index + 1]![1] <= clamped) index += 1;
  const [from, start, to, end] = bounds(marks, duration, index);
  const share = end > start ? (clamped - start) / (end - start) : 0;
  return Math.min(1, from + share * (to - from));
}

/** Second at which the share `fraction` of the segment's text is spoken. */
export function timeForFraction(fraction: number, duration: number, marks?: Marks | null): number {
  if (!(duration > 0)) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  if (!marks || marks.length < 2) return clamped * duration;
  let index = 0;
  while (index + 1 < marks.length && marks[index + 1]![0] <= clamped) index += 1;
  const [from, start, to, end] = bounds(marks, duration, index);
  const share = to > from ? (clamped - from) / (to - from) : 0;
  return start + share * (end - start);
}
