/** Navigation state on links from the player to a book page, so that page's
 * Back goes Home instead of reopening the player it was reached from. */
export const FROM_PLAYER = { fromPlayer: true } as const;

export function cameFromPlayer(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { fromPlayer?: unknown }).fromPlayer === true;
}
