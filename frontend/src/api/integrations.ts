/** Admin → Integrations: provider keys and the language model.
 * GET    /admin/integrations                         → Integrations (keys masked)
 * PUT    /admin/integrations                         → Integrations (partial; a key
 *        left out stays, an empty one is removed)
 * POST   /admin/integrations/google-books/test       → TestResult  ({api_key?} draft)
 * POST   /admin/integrations/language-model/test     → TestResult  (draft fields)
 * POST   /admin/integrations/language-model/test-ocr → OcrResult   (multipart: file?, draft fields)
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
    key_set: boolean;
    key_hint: string | null;
  };
  /** Voice and book delivery notes reach the speech engine only when on. */
  style_prompts: boolean;
}

export interface LanguageModelDraft {
  base_url?: string;
  model?: string;
  ocr_model?: string;
  /** null removes the saved key; leave it out to keep it. */
  api_key?: string | null;
  ocr?: boolean;
  suggest?: boolean;
}

export interface IntegrationsUpdate {
  google_books_api_key?: string | null;
  language_model?: LanguageModelDraft;
}

export interface TestResult {
  ok: boolean;
  message: string;
  reply?: string;
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
