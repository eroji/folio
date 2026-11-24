/** Admin → Integrations: provider keys, the language model and the TTS server.
 * GET    /admin/integrations                         → Integrations (keys masked)
 * PUT    /admin/integrations                         → Integrations (partial; a key
 *        left out stays, an empty one is removed)
 * POST   /admin/integrations/google-books/test       → TestResult  ({api_key?} draft)
 * POST   /admin/integrations/language-model/test     → TestResult  (draft fields)
 * POST   /admin/integrations/language-model/test-ocr → OcrResult   (multipart: file?, draft fields)
 * POST   /admin/integrations/language-model/models   → ModelList   (draft base_url/api_key)
 * POST   /admin/integrations/tts/test                → TtsTestResult (draft base_url/api_key)
 * A test never saves; fields it is not given fall back to the saved ones. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface Integrations {
  google_books: { key_set: boolean; key_hint: string | null; env_key: boolean };
  language_model: {
    base_url: string;
    model: string;
    ocr_model: string;
    ocr: boolean;
    suggest: boolean;
    /** Off: every request asks the model not to think first. */
    thinking: boolean;
    key_set: boolean;
    key_hint: string | null;
  };
  /** Voice and book delivery notes reach the speech engine only when on. */
  style_prompts: boolean;
  tts: TtsServer;
}

/** Admin → Voices → TTS server. Empty base_url: TTS_BASE_URL from the server
 * (with TTS_API_KEY, which is never sent to a URL set here). */
export interface TtsServer {
  base_url: string;
  env_base_url: string;
  key_set: boolean;
  key_hint: string | null;
  /** "" : TTS_MODEL (env_model). */
  model: string;
  env_model: string;
  /** null: TTS_CONCURRENCY (env_concurrency). */
  concurrency: number | null;
  env_concurrency: number;
  /** true: one request per sentence; false: whole segment; null: TTS_REQUEST_CHARS. */
  sentence_requests: boolean | null;
  /** 0: whole segment; above 0: one sentence each. */
  env_request_chars: number;
  /** Which base URL is in effect. */
  source: "admin" | "env" | "none";
}

export interface TtsServerDraft {
  /** "" goes back to TTS_BASE_URL. */
  base_url?: string;
  /** null removes the saved key; leave it out to keep it. */
  api_key?: string | null;
  /** "" goes back to TTS_MODEL. */
  model?: string;
  /** null goes back to TTS_CONCURRENCY. */
  concurrency?: number | null;
  /** null goes back to TTS_REQUEST_CHARS. */
  sentence_requests?: boolean | null;
}

export interface LanguageModelDraft {
  base_url?: string;
  model?: string;
  ocr_model?: string;
  /** null removes the saved key; leave it out to keep it. */
  api_key?: string | null;
  ocr?: boolean;
  suggest?: boolean;
  thinking?: boolean;
}

export interface IntegrationsUpdate {
  google_books_api_key?: string | null;
  language_model?: LanguageModelDraft;
  tts?: TtsServerDraft;
}

export interface TestResult {
  ok: boolean;
  message: string;
  reply?: string;
}

export interface TtsTestResult extends TestResult {
  voices?: number;
  latency_ms?: number;
}

export interface ModelList {
  ok: boolean;
  models: string[];
  message?: string;
}

export interface OcrResult extends TestResult {
  text?: string;
  /** The built-in sample page's text (null when a file was read). */
  expected?: string | null;
}

export const integrationsQueryKey = ["admin", "integrations"] as const;

export function useIntegrations() {
  return useQuery({
    queryKey: integrationsQueryKey,
    queryFn: () => api.get<Integrations>("/admin/integrations"),
  });
}

export function useSaveIntegrations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: IntegrationsUpdate) => api.put<Integrations>("/admin/integrations", update),
    onSuccess: (data) => queryClient.setQueryData(integrationsQueryKey, data),
  });
}

export function testGoogleBooks(apiKey?: string): Promise<TestResult> {
  return api.post<TestResult>("/admin/integrations/google-books/test", apiKey ? { api_key: apiKey } : {});
}

export function testLanguageModel(draft: LanguageModelDraft): Promise<TestResult> {
  return api.post<TestResult>("/admin/integrations/language-model/test", draft);
}

export function testOcr(draft: LanguageModelDraft, file?: File): Promise<OcrResult> {
  const form = new FormData();
  for (const name of ["base_url", "model", "ocr_model", "api_key"] as const) {
    const value = draft[name];
    if (typeof value === "string") form.append(name, value);
  }
  if (file) form.append("file", file, file.name);
  return api.post<OcrResult>("/admin/integrations/language-model/test-ocr", form);
}

/** The models the endpoint offers (GET {base_url}/models, asked by the server). */
export function listModels(draft: LanguageModelDraft): Promise<ModelList> {
  return api.post<ModelList>("/admin/integrations/language-model/models", draft);
}

/** List the draft server's voices (fields left out: the saved ones). */
export function testTtsServer(draft: Pick<TtsServerDraft, "base_url" | "api_key">): Promise<TtsTestResult> {
  return api.post<TtsTestResult>("/admin/integrations/tts/test", draft);
}
