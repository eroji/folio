/** Typed calls + queries for the M4 voice endpoints (plan Task D contract).
 * Types live here rather than in api/types.ts because only this surface uses voices. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, csrfToken } from "./client";

export interface Voice {
  id: string;
  language: string | null;
  description: string | null;
  available: boolean;
  /** Human-readable name from the engine; absent on payloads predating it. */
  display_name?: string | null;
}

/** Menu/picker label: display_name when the API provides it, otherwise the
 * parsed id ("ashley-en" → "Ashley"). */
export function voiceDisplayName(voice: Voice): string {
  if (voice.display_name) return voice.display_name;
  const head = voice.id.split("-")[0] ?? voice.id;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

export interface VoicesResponse {
  items: Voice[];
}

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
    const key = voice.language ? voice.language.split("-")[0]!.toLowerCase() : "any";
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
