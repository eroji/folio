/** Notices a deploy while the app is open. An installed iOS PWA is resumed,
 * not relaunched, so it can run an old bundle for days: on start and whenever
 * the app comes back to the foreground (at most once a minute) this compares
 * /version.json with the build it is running. A newer build reloads the page
 * at once unless audio is playing; then `outdated` asks the listener instead.
 * A build is reloaded for at most once per tab, so a stale cache can't loop. */
import { useCallback, useEffect, useRef, useState } from "react";

export const BUILD_ID = __FOLIO_BUILD__;
const MIN_INTERVAL_MS = 60_000;
const RELOADED_KEY = "folio-reloaded-for";

function readReloaded(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_KEY);
  } catch {
    return null;
  }
}

function markReloaded(build: string) {
  try {
    sessionStorage.setItem(RELOADED_KEY, build);
  } catch {
    // Without storage the loop guard is off; the reload still happens once per check.
  }
}

export function useAppUpdate({
  enabled,
  isBusy,
  reload = () => window.location.reload(),
}: {
  enabled: boolean;
  /** True while reloading would interrupt the listener (audio playing). */
  isBusy: () => boolean;
  reload?: () => void;
}): { outdated: boolean; reload: () => void } {
  const [outdated, setOutdated] = useState(false);
  const lastCheck = useRef(0);
  const busy = useRef(isBusy);
  busy.current = isBusy;
  const doReload = useRef(reload);
  doReload.current = reload;

  const check = useCallback(async () => {
    const now = Date.now();
    if (lastCheck.current && now - lastCheck.current < MIN_INTERVAL_MS) return;
    lastCheck.current = now;
    // A waiting service worker takes over too (it skips waiting on install).
    void navigator.serviceWorker?.getRegistration?.().then((registration) => registration?.update()).catch(() => {});
    let latest: unknown;
    try {
      const response = await fetch("/version.json", { cache: "no-store" });
      if (!response.ok) return;
      latest = ((await response.json()) as { build?: unknown }).build;
    } catch {
      return; // offline or not a Folio build: try again next time
    }
    if (typeof latest !== "string" || !latest || latest === BUILD_ID) return;
    if (!busy.current() && readReloaded() !== latest) {
      markReloaded(latest);
      doReload.current();
      return;
    }
    setOutdated(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, check]);

  return { outdated, reload: () => doReload.current() };
}
