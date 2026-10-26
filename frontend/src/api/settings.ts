/** Typed calls + hooks for the M5 per-user listening settings (plan Task R).
 * GET/PUT /me/settings. Offline the cache falls back to the localStorage keys
 * the M4 settings page used (folio-speed, folio-voice-<lang>), so the player
 * still starts at the last speed and language voice without a server. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface ListeningSettings {
  speed: number;
  /** Pinned narrator per base language ("en", "ja", "ko", "zh");
   * null = follow the server default. */
  voices: Record<string, string | null>;
  skip_back: number;
  skip_forward: number;
  auto_next: boolean;
  speak_titles: boolean;
}

/** Matches the server defaults (auto-play and chapter titles on by default). */
export const DEFAULT_SETTINGS: ListeningSettings = {
  speed: 1,
  voices: {},
  skip_back: 15,
  skip_forward: 30,
  auto_next: true,
  speak_titles: true,
};

export const settingsQueryKey = ["settings"] as const;

const SPEED_KEY = "folio-speed";
const VOICE_PREFIX = "folio-voice-";

/** Mirror the parts the offline player needs into localStorage. */
function mirror(patch: Partial<ListeningSettings>): void {
  if (patch.speed !== undefined) localStorage.setItem(SPEED_KEY, String(patch.speed));
  for (const [language, voice] of Object.entries(patch.voices ?? {})) {
    if (voice) localStorage.setItem(`${VOICE_PREFIX}${language}`, voice);
    else localStorage.removeItem(`${VOICE_PREFIX}${language}`); // null = server default
  }
}

/** Rebuild settings from the localStorage mirror when the server is unreachable. */
function fromLocalStorage(): ListeningSettings {
  const voices: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(VOICE_PREFIX)) {
      const value = localStorage.getItem(key);
      if (value) voices[key.slice(VOICE_PREFIX.length)] = value;
    }
  }
  const stored = Number(localStorage.getItem(SPEED_KEY));
  return { ...DEFAULT_SETTINGS, ...(Number.isFinite(stored) ? { speed: stored } : {}), voices };
}

export function useListeningSettings() {
  const query = useQuery({
    queryKey: settingsQueryKey,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ListeningSettings> => {
      try {
        const res = await api.get<{ settings: Partial<ListeningSettings> }>("/me/settings");
        return { ...DEFAULT_SETTINGS, ...res.settings };
      } catch {
        return fromLocalStorage(); // offline / server error: use this device's mirror
      }
    },
  });
  return { ...query, settings: query.data ?? DEFAULT_SETTINGS };
}

export type SettingsSaveStatus = "idle" | "saving" | "saved" | "error";

/** Writes coalesce over this window so a burst of edits is one PUT. */
const COALESCE_MS = 400;

/** Optimistic, coalesced writes: every change updates the cache and the
 * localStorage mirror immediately and merges into one debounced PUT of just
 * the changed keys. A failed PUT reverts the cache to the pre-patch value
 * and surfaces `error` so the page can say so; offline the GET fallback
 * still reads the localStorage mirror. */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SettingsSaveStatus>("idle");
  const buffer = useRef<Partial<ListeningSettings>>({});
  const timer = useRef<number | null>(null);
  /** Cache value from before the first unsaved patch; restores it when a PUT
   * fails so the controls revert to the server's truth. */
  const snapshot = useRef<ListeningSettings | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: Partial<ListeningSettings>) =>
      api.put<{ settings: Partial<ListeningSettings> }>("/me/settings", patch),
    onSuccess: (data) => {
      snapshot.current = null;
      queryClient.setQueryData(settingsQueryKey, { ...DEFAULT_SETTINGS, ...data.settings });
      setStatus("saved");
    },
    onError: () => {
      if (snapshot.current) queryClient.setQueryData(settingsQueryKey, snapshot.current);
      snapshot.current = null;
      setStatus("error");
    },
  });
  const send = useRef(mutation.mutate);
  send.current = mutation.mutate;

  function flush() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const body = buffer.current;
    buffer.current = {};
    if (Object.keys(body).length > 0) send.current(body);
  }

  const update = useCallback(
    (patch: Partial<ListeningSettings>) => {
      const current = queryClient.getQueryData<ListeningSettings>(settingsQueryKey) ?? DEFAULT_SETTINGS;
      snapshot.current ??= current;
      queryClient.setQueryData(settingsQueryKey, { ...current, ...patch }); // optimistic
      mirror(patch);
      buffer.current = { ...buffer.current, ...patch };
      setStatus("saving");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, COALESCE_MS);
    },
    [queryClient],
  );

  // Never lose a change that is still waiting in the debounce window.
  useEffect(() => () => flush(), []);

  return { update, status };
}
