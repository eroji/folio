/** Typed calls + hooks for the per-book pronunciation rules (plan Task C
 * contract, endpoints built in parallel):
 * GET    /books/{id}/pronunciation        → {items:[rule]}
 * POST   /books/{id}/pronunciation        → {rule}
 * PATCH  /books/{id}/pronunciation/{rid}  → {rule}   (partial body)
 * DELETE /books/{id}/pronunciation/{rid}  → 204
 * All writes are optimistic against the list cache and revert on error. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface PronunciationRule {
  id: string;
  match: string;
  say: string;
  whole_word: boolean;
  after_number: boolean;
  case_sensitive: boolean;
}

/** POST body / PATCH body (PATCH sends only the changed keys). */
export type PronunciationRuleInput = Omit<PronunciationRule, "id">;

interface RulesResponse {
  items: PronunciationRule[];
}

export function pronunciationQueryKey(bookId: string) {
  return ["pronunciation", bookId] as const;
}

function readRules(queryClient: QueryClient, bookId: string): PronunciationRule[] {
  return queryClient.getQueryData<RulesResponse>(pronunciationQueryKey(bookId))?.items ?? [];
}

function writeRules(queryClient: QueryClient, bookId: string, items: PronunciationRule[]): void {
  queryClient.setQueryData<RulesResponse>(pronunciationQueryKey(bookId), { items });
}

export function usePronunciationRules(bookId: string, enabled = true) {
  return useQuery({
    queryKey: pronunciationQueryKey(bookId),
    queryFn: () => api.get<RulesResponse>(`/books/${bookId}/pronunciation`),
    enabled: Boolean(bookId) && enabled,
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
  return useMutation<PronunciationRule, Error, { ruleId: string; patch: Partial<PronunciationRuleInput> }, { prev: PronunciationRule[] }>({
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
