/** "Stop and close" must survive a reload: the app-start auto-load (AppShell)
 * would otherwise bring the closed player straight back. Per device; cleared
 * as soon as any book is loaded here again. */
const KEY = "folio-player-closed";

export function rememberClosed(bookId: string): void {
  try {
    localStorage.setItem(KEY, bookId);
  } catch {
    /* storage unavailable: the player may come back after a reload */
  }
}

export function forgetClosed(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** The book whose player was closed on this device, if any. */
export function closedBook(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
