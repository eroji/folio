/** Typed calls + queries for the M4 voice endpoints (plan Task D contract).
 * Types live here rather than in api/types.ts because only this surface uses voices. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, api, csrfToken } from "./client";

export interface Voice {
  id: string;
  /** Detected or manually overridden base language; null = undetected. */
  language?: string | null;
  description?: string | null;
  /** Older payloads; new servers send `on_server`. Use voiceOnServer(). */
  available?: boolean;
  /** Admin override or name derived from the id ("ashley-en" -> "Ashley"). */
  display_name?: string | null;
  is_default?: boolean;
  books_count?: number;
  on_server?: boolean;
  /** True when the language was set manually (shows the Unassign pill). */
  language_overridden?: boolean;
  /** Per-voice narration instruction sent with TTS requests; "" when unset. */
  instructions?: string;
}

export interface VoicesResponse {
  items: Voice[];
  /** Server default voice per base language; null when the server has none. */
  defaults?: Record<string, string | null>;
}

/** "zh-TW" / "zh_Hans" / "zh" -> "zh"; lower-case base of a language tag. */
export function baseLanguage(code: string): string {
  return code.split(/[-_]/)[0]!.toLowerCase();
}

/** Body of PATCH /admin/voices/{id}. */
export type VoicePatch = {
  display_name?: string | null;
  language_override?: string | null;
  instructions?: string;
};

/** Whether the TTS server still lists this voice (`on_server`, older `available`). */
export function voiceOnServer(voice: Voice): boolean {
  return voice.on_server ?? voice.available ?? true;
}

/** Base language group of a voice: the server's `language` field, else the
 * id suffix (-en, -ja, -ko/-kr, -zh); -kr folds into ko, all Chinese
 * variants into zh. Null when undetectable (Unassigned). */
export function voiceLanguage(voice: Voice): string | null {
  const raw = voice.language ?? voice.id.match(/-(en|ja|ko|kr|zh)(?:-[a-z]{2})?$/i)?.[1];
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0]!.toLowerCase();
  return base === "kr" ? "ko" : base;
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

/** Apply an updater to the cached voice list under both query keys. */
function patchVoicesCache(queryClient: QueryClient, update: (data: VoicesResponse) => VoicesResponse) {
  for (const refresh of [false, true]) {
    queryClient.setQueryData<VoicesResponse>(voicesQueryKey(refresh), (old) => (old ? update(old) : old));
  }
}

/** PATCH /admin/voices/{id}: display name and/or manual language override.
 * The returned item is merged into the cache so rows move groups at once. */
export function useUpdateVoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & VoicePatch) =>
      api.patch<{ item?: Voice }>(`/admin/voices/${encodeURIComponent(id)}`, patch),
    onSuccess: (data) => {
      const item = data?.item;
      if (item) {
        patchVoicesCache(queryClient, (old) => ({
          ...old,
          items: old.items.map((voice) => (voice.id === item.id ? { ...voice, ...item } : voice)),
        }));
      }
      queryClient.invalidateQueries({ queryKey: ["voices"] });
    },
  });
}

/** PUT /admin/voices/defaults: the server-wide default for one language. */
export function useSetVoiceDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ language, voiceId }: { language: string; voiceId: string }) =>
      api.put<{ defaults?: Record<string, string> }>("/admin/voices/defaults", { language, voice_id: voiceId }),
    onSuccess: (data, { language, voiceId }) => {
      const defaults = { ...data?.defaults, [language]: voiceId };
      patchVoicesCache(queryClient, (old) => ({ ...old, defaults: { ...old.defaults, ...defaults } }));
      queryClient.invalidateQueries({ queryKey: ["voices"] });
    },
  });
}

/** DELETE /admin/voices/{id} (204): drop a voice the server no longer has. */
export function useDeleteVoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/admin/voices/${encodeURIComponent(id)}`),
    onSuccess: (_result, id) => {
      patchVoicesCache(queryClient, (old) => ({ ...old, items: old.items.filter((voice) => voice.id !== id) }));
      queryClient.invalidateQueries({ queryKey: ["voices"] });
    },
  });
}
