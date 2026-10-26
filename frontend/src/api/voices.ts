/** Typed calls + queries for the M4 voice endpoints (plan Task D contract).
 * Types live here rather than in api/types.ts because only this surface uses voices. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, csrfToken } from "./client";

export interface Voice {
  id: string;
  language: string | null;
  description: string | null;
  available: boolean;
  /** Admin override or name derived from the id ("ashley-en" -> "Ashley"). */
  display_name?: string | null;
  /** Fields the backend adds with the voices redesign; optional so this
   * compiles before the merge. `on_server` supersedes `available`. */
  on_server?: boolean;
  is_default?: boolean;
  books_count?: number;
  language_overridden?: boolean;
}

export interface VoicesResponse {
  items: Voice[];
  /** Server default voice per base language; null when the server has none. */
  defaults?: Record<string, string | null>;
}

/** Whether the engine can still speak this voice. */
export function voiceOnServer(voice: Voice): boolean {
  return voice.on_server ?? voice.available;
}

/** "zh-TW" / "zh_Hans" / "zh" -> "zh"; lower-case base of a language tag. */
export function baseLanguage(code: string): string {
  return code.split(/[-_]/)[0]!.toLowerCase();
}

/** Human label for a voice: `display_name` when present, else the id without
 * its trailing language suffix, capitalised ("ashley-en" → "Ashley"). */
export function voiceLabel(voice: Voice): string {
  if (voice.display_name) return voice.display_name;
  const base = voice.id.replace(/-[a-z]{2}(-[a-z]{2})?$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Alias used by the book-page voice menu. */
export const voiceDisplayName = voiceLabel;

export const voicesQueryKey = (refresh: boolean): readonly ["voices", boolean] =>
  ["voices", refresh] as const;

export function useVoices(refresh = false) {
  return useQuery({
    queryKey: voicesQueryKey(refresh),
    queryFn: () => api.get<VoicesResponse>(`/voices?refresh=${refresh}`),
    staleTime: 60_000, // mirrors the server-side TTS_VOICES_TTL
  });
}

/** GET /voices?refresh=true and push the result into the cached list every
 * picker reads. A mutation rather than useVoices(true) so the refresh cannot
 * race the pickers' own mount fetch over one query key. */
export function useRefreshVoices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.get<VoicesResponse>("/voices?refresh=true"),
    onSuccess: (data) => {
      queryClient.setQueryData(voicesQueryKey(false), data);
      queryClient.setQueryData(voicesQueryKey(true), data);
    },
  });
}

/** Voices keyed by base language ("en", "ja", "ko", "zh"); untagged ones under "any". */
export function groupVoicesByLanguage(voices: Voice[]): Record<string, Voice[]> {
  const groups: Record<string, Voice[]> = {};
  for (const voice of voices) {
    const key = voice.language ? baseLanguage(voice.language) : "any";
    (groups[key] ??= []).push(voice);
  }
  return groups;
}

/** POST /voices/preview answers with audio bytes, so the JSON api client
 * cannot be used; credentials and the CSRF header follow api/client.ts.
 * Returns an object URL; the caller must revoke it. */
export async function previewVoice(voice: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = csrfToken();
  if (token) headers["X-CSRF-Token"] = token;
  const response = await fetch("/api/v1/voices/preview", {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify({ voice }),
  });
  if (!response.ok) {
    let code = "request_failed";
    let message = "Something went wrong.";
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Audio or non-JSON error body: keep the generic message.
    }
    throw new ApiError(code, message, response.status);
  }
  return URL.createObjectURL(await response.blob());
}
