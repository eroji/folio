/** Typed calls + hooks for the per-book pronunciation rules (plan Task C
 * contract, endpoints built in parallel):
 * GET    /books/{id}/pronunciation        → {items:[rule]}
 * POST   /books/{id}/pronunciation        → {rule}
 * PATCH  /books/{id}/pronunciation/{rid}  → {rule}   (partial body)
 * DELETE /books/{id}/pronunciation/{rid}  → 204
 * POST   /books/{id}/pronunciation/suggest → {job_id} (202; 409 without a language model)
 * Suggested rules (the language model's) change nothing until accepted
 * (PATCH {suggested: false}). All writes are optimistic against the list
 * cache and revert on error. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface PronunciationRule {
  id: string;
  match: string;
  say: string;
  whole_word: boolean;
  after_number: boolean;
  case_sensitive: boolean;
  /** Proposed by the language model; not used for speech until accepted. */
  suggested?: boolean;
}

/** POST body (PATCH sends only the changed keys, and `suggested: false` to accept). */
export type PronunciationRuleInput = Omit<PronunciationRule, "id" | "suggested">;
export type PronunciationRulePatch = Partial<PronunciationRuleInput> & { suggested?: false };

export interface RulesResponse {
  items: PronunciationRule[];
  /** A language model is set up, so rules can be suggested. */
  can_suggest?: boolean;
  /** A suggestion job is queued or running for this book. */
  suggesting?: boolean;
  /** The speech engine receives style prompts (delivery notes) at all. */
  style_prompts?: boolean;
}

export function pronunciationQueryKey(bookId: string) {
  return ["pronunciation", bookId] as const;
}

function readRules(queryClient: QueryClient, bookId: string): PronunciationRule[] {
  return queryClient.getQueryData<RulesResponse>(pronunciationQueryKey(bookId))?.items ?? [];
}

function writeRules(queryClient: QueryClient, bookId: string, items: PronunciationRule[]): void {
  queryClient.setQueryData<RulesResponse>(pronunciationQueryKey(bookId), (current) => ({ ...current, items }));
}

/** While suggestions are being made, poll until they land (the job event
 * also refreshes the list when the events stream is connected). */
const SUGGEST_POLL_MS = 4000;

export function usePronunciationRules(bookId: string, enabled = true) {
  return useQuery({
    queryKey: pronunciationQueryKey(bookId),
    queryFn: () => api.get<RulesResponse>(`/books/${bookId}/pronunciation`),
    enabled: Boolean(bookId) && enabled,
    refetchInterval: (query) => (query.state.data?.suggesting ? SUGGEST_POLL_MS : false),
  });
}

/** Ask the language model for rules and a delivery note (a background job). */
export function useSuggestPronunciation(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ job_id: string }>(`/books/${bookId}/pronunciation/suggest`),
    onSuccess: () =>
      queryClient.setQueryData<RulesResponse>(pronunciationQueryKey(bookId), (current) =>
        current ? { ...current, suggesting: true } : current,
      ),
  });
}

/** Appends a temp row, swaps in the server rule on success, reverts on error. */
export function useAddPronunciationRule(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<PronunciationRule, Error, PronunciationRuleInput, { prev: PronunciationRule[]; tempId: string }>({
    mutationFn: (input) => api.post<{ rule: PronunciationRule }>(`/books/${bookId}/pronunciation`, input).then((data) => data.rule),
    onMutate: (input) => {
      const prev = readRules(queryClient, bookId);
      const tempId = `temp-${crypto.randomUUID()}`;
      writeRules(queryClient, bookId, [...prev, { id: tempId, ...input }]);
      return { prev, tempId };
    },
    onSuccess: (rule, _input, context) => {
      writeRules(queryClient, bookId, readRules(queryClient, bookId).map((rule2) => (rule2.id === context.tempId ? rule : rule2)));
    },
    onError: (_error, _input, context) => {
      if (context) writeRules(queryClient, bookId, context.prev);
    },
  });
}

/** Patches the row in the cache immediately, then PATCHes the server. */
export function useUpdatePronunciationRule(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<PronunciationRule, Error, { ruleId: string; patch: PronunciationRulePatch }, { prev: PronunciationRule[] }>({
    mutationFn: ({ ruleId, patch }) =>
      api.patch<{ rule: PronunciationRule }>(`/books/${bookId}/pronunciation/${ruleId}`, patch).then((data) => data.rule),
    onMutate: ({ ruleId, patch }) => {
      const prev = readRules(queryClient, bookId);
      writeRules(queryClient, bookId, prev.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)));
      return { prev };
    },
    onSuccess: (rule) => {
      writeRules(queryClient, bookId, readRules(queryClient, bookId).map((current) => (current.id === rule.id ? rule : current)));
    },
    onError: (_error, _variables, context) => {
      if (context) writeRules(queryClient, bookId, context.prev);
    },
  });
}

export function useDeletePronunciationRule(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<undefined, Error, string, { prev: PronunciationRule[] }>({
    mutationFn: (ruleId) => api.del<undefined>(`/books/${bookId}/pronunciation/${ruleId}`),
    onMutate: (ruleId) => {
      const prev = readRules(queryClient, bookId);
      writeRules(queryClient, bookId, prev.filter((rule) => rule.id !== ruleId));
      return { prev };
    },
    onError: (_error, _ruleId, context) => {
      if (context) writeRules(queryClient, bookId, context.prev);
    },
  });
}
