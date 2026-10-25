import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  useAddPronunciationRule,
  useDeletePronunciationRule,
  usePronunciationRules,
  useUpdatePronunciationRule,
  type PronunciationRule,
} from "../api/pronunciation";

const inputClass = "min-h-11 w-full min-w-24 rounded-card border border-line bg-page px-2 text-sm";

interface Draft {
  match: string;
  say: string;
  whole_word: boolean;
  after_number: boolean;
  case_sensitive: boolean;
}

const EMPTY_DRAFT: Draft = { match: "", say: "", whole_word: false, after_number: false, case_sensitive: false };

/** Book settings → Pronunciation rules (plan Task C): a table of match → say
 * replacements with the three flags, a remove button per row, and an "Add
 * rule" row. Every write is optimistic against the list cache and reverts on
 * error; text edits commit on blur so typing does not fire a PATCH per key. */
export function PronunciationRules({ bookId }: { bookId: string }) {
  const { data, isPending, error: loadError } = usePronunciationRules(bookId);
  const add = useAddPronunciationRule(bookId);
  const update = useUpdatePronunciationRule(bookId);
  const remove = useDeletePronunciationRule(bookId);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [edits, setEdits] = useState<Record<string, { match?: string; say?: string }>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const rules = data?.items ?? [];

  function done() {
    setSaved(true);
  }

  function duplicateMatch(value: string, exceptId?: string): boolean {
    const target = value.trim().toLowerCase();
    return rules.some((rule) => rule.id !== exceptId && rule.match.trim().toLowerCase() === target);
  }

  function addRule() {
    if (draft.match.trim() === "") {
      setFormError("Enter the text to match.");
      return;
    }
    if (duplicateMatch(draft.match)) {
      setFormError("A rule for that match already exists.");
      return;
    }
    setFormError(null);
    setSaved(false);
    add.mutate({ ...draft, match: draft.match.trim() }, { onSuccess: done });
    setDraft(EMPTY_DRAFT);
  }

  function commitText(rule: PronunciationRule, field: "match" | "say") {
    const next = (edits[rule.id]?.[field] ?? rule[field]).trim();
    const buffer = { ...edits[rule.id] };
    delete buffer[field];
    setEdits((current) => ({ ...current, [rule.id]: buffer }));
    if (field === "match" && next === "") {
      setFormError("Enter the text to match.");
      return;
    }
    if (field === "match" && duplicateMatch(next, rule.id)) {
      setFormError("A rule for that match already exists.");
      return;
    }
    setFormError(null);
    if (next === rule[field]) return;
    setSaved(false);
    update.mutate({ ruleId: rule.id, patch: { [field]: next } }, { onSuccess: done });
  }

  function toggleFlag(rule: PronunciationRule, field: "whole_word" | "after_number" | "case_sensitive", value: boolean) {
    setSaved(false);
    update.mutate({ ruleId: rule.id, patch: { [field]: value } }, { onSuccess: done });
  }

  function removeRule(rule: PronunciationRule) {
    setSaved(false);
    remove.mutate(rule.id, { onSuccess: done });
  }

  const error =
    formError ??
    (add.isError || update.isError || remove.isError ? "The change could not be saved." : loadError instanceof Error ? loadError.message : null);

  return (
    <div className="flex flex-col gap-2">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="px-2 py-1 font-medium">Match</th>
            <th scope="col" className="px-2 py-1 font-medium">Say</th>
            <th scope="col" className="px-2 py-1 font-medium">Whole word</th>
            <th scope="col" className="px-2 py-1 font-medium">After a number</th>
            <th scope="col" className="px-2 py-1 font-medium">Case-sensitive</th>
            <th scope="col" className="px-2 py-1"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {isPending && (
            <tr>
              <td colSpan={6} className="px-2 py-2 text-muted">Loading rules…</td>
            </tr>
          )}
          {!isPending && rules.length === 0 && (
            <tr>
              <td colSpan={6} className="px-2 py-2 text-muted">No rules yet.</td>
            </tr>
          )}
          {rules.map((rule, index) => (
            <tr key={rule.id} className="border-t border-line">
              <td className="px-1 py-1">
                <input
                  aria-label={`Match ${index + 1}`}
                  value={edits[rule.id]?.match ?? rule.match}
                  onChange={(event) => setEdits((current) => ({ ...current, [rule.id]: { ...current[rule.id], match: event.target.value } }))}
                  onBlur={() => commitText(rule, "match")}
                  className={inputClass}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  aria-label={`Say ${index + 1}`}
                  value={edits[rule.id]?.say ?? rule.say}
                  onChange={(event) => setEdits((current) => ({ ...current, [rule.id]: { ...current[rule.id], say: event.target.value } }))}
                  onBlur={() => commitText(rule, "say")}
                  className={inputClass}
                />
              </td>
              <td className="px-2 py-1 text-center">
                <input
                  type="checkbox"
                  aria-label={`Whole word ${index + 1}`}
                  checked={rule.whole_word}
                  onChange={(event) => toggleFlag(rule, "whole_word", event.target.checked)}
                  className="h-5 w-5"
                />
              </td>
              <td className="px-2 py-1 text-center">
                <input
                  type="checkbox"
                  aria-label={`After a number ${index + 1}`}
                  checked={rule.after_number}
                  onChange={(event) => toggleFlag(rule, "after_number", event.target.checked)}
                  className="h-5 w-5"
                />
              </td>
              <td className="px-2 py-1 text-center">
                <input
                  type="checkbox"
                  aria-label={`Case-sensitive ${index + 1}`}
                  checked={rule.case_sensitive}
                  onChange={(event) => toggleFlag(rule, "case_sensitive", event.target.checked)}
                  className="h-5 w-5"
                />
              </td>
              <td className="px-1 py-1 text-right">
                <button
                  type="button"
                  aria-label={`Remove rule ${index + 1}`}
                  onClick={() => removeRule(rule)}
                  className="grid h-11 w-11 place-items-center rounded-pill text-muted hover:text-danger"
                >
                  <X size={18} strokeWidth={1.75} aria-hidden />
                </button>
              </td>
            </tr>
          ))}
          <tr className="border-t border-line bg-card">
            <td className="px-1 py-1">
              <input
                aria-label="New match"
                placeholder="Text to match"
                value={draft.match}
                onChange={(event) => setDraft((current) => ({ ...current, match: event.target.value }))}
                className={inputClass}
              />
            </td>
            <td className="px-1 py-1">
              <input
                aria-label="New say"
                placeholder="Replacement"
                value={draft.say}
                onChange={(event) => setDraft((current) => ({ ...current, say: event.target.value }))}
                className={inputClass}
              />
            </td>
            {(["whole_word", "after_number", "case_sensitive"] as const).map((field) => (
              <td key={field} className="px-2 py-1 text-center">
                <input
                  type="checkbox"
                  aria-label={`New rule ${field.replace(/_/g, " ")}`}
                  checked={draft[field]}
                  onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.checked }))}
                  className="h-5 w-5"
                />
              </td>
            ))}
            <td className="px-1 py-1 text-right">
              <button
                type="button"
                onClick={addRule}
                disabled={add.isPending}
                className="inline-flex min-h-11 items-center gap-1 rounded-pill border border-line bg-card px-3 text-sm font-medium disabled:opacity-50"
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {saved && !error && <p aria-live="polite" className="text-sm text-muted">Saved</p>}
    </div>
  );
}
