import { useState } from "react";
import {
  useAddPronunciationRule,
  useDeletePronunciationRule,
  usePronunciationRules,
  useSuggestPronunciation,
  useUpdatePronunciationRule,
  type PronunciationRule,
} from "../api/pronunciation";
import { Icon } from "./Icon";

const inputClass = "tap h-10 min-w-24 flex-1 rounded-md border border-border bg-raised px-3.5 text-md";

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
 * error; text edits commit on blur so typing does not fire a PATCH per key.
 * The language model's suggestions are listed apart, to accept (they then
 * shape the speech) or dismiss; nothing about the audio changes before that. */
export function PronunciationRules({ bookId }: { bookId: string }) {
  const { data, isPending, error: loadError } = usePronunciationRules(bookId);
  const add = useAddPronunciationRule(bookId);
  const update = useUpdatePronunciationRule(bookId);
  const remove = useDeletePronunciationRule(bookId);
  const suggest = useSuggestPronunciation(bookId);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [edits, setEdits] = useState<Record<string, { match?: string; say?: string }>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const all = data?.items ?? [];
  const rules = all.filter((rule) => !rule.suggested);
  const suggestions = all.filter((rule) => rule.suggested);
  const suggesting = Boolean(data?.suggesting) || suggest.isPending;

  const [draftOpen, setDraftOpen] = useState(false);

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
      return false;
    }
    if (duplicateMatch(draft.match)) {
      setFormError("A rule for that match already exists.");
      return false;
    }
    setFormError(null);
    setSaved(false);
    add.mutate({ ...draft, match: draft.match.trim() }, { onSuccess: done });
    setDraft(EMPTY_DRAFT);
    return true;
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

  function accept(rule: PronunciationRule) {
    setSaved(false);
    update.mutate({ ruleId: rule.id, patch: { suggested: false } }, { onSuccess: done });
  }

  const error =
    formError ??
    (suggest.isError
      ? suggest.error.message
      : add.isError || update.isError || remove.isError
        ? "The change could not be saved."
        : loadError instanceof Error
          ? loadError.message
          : null);

  const flags = (rule: PronunciationRule, index: number) =>
    (["whole_word", "after_number", "case_sensitive"] as const).map((field) => (
      <label key={field} className="flex shrink-0 items-center gap-1 text-xs text-fg-2">
        <input
          type="checkbox"
          aria-label={`${field.replace(/_/g, " ")} ${index + 1}`}
          checked={rule[field]}
          onChange={(event) => toggleFlag(rule, field, event.target.checked)}
          className="size-4 accent-accent"
        />
        {field.replace(/_/g, " ")}
      </label>
    ));

  return (
    <div className="flex flex-col gap-2">
      {isPending && <p className="py-1 text-md text-fg-2">Loading rules…</p>}
      {!isPending && rules.length === 0 && !draftOpen && (
        <p className="py-1 text-md text-fg-2">No rules yet.</p>
      )}
      <ul className="flex flex-col gap-1.5">
        {rules.map((rule, index) => (
          <li key={rule.id} className="flex flex-wrap items-center gap-2.5">
            <input
              aria-label={`Match ${index + 1}`}
              value={edits[rule.id]?.match ?? rule.match}
              onChange={(event) => setEdits((current) => ({ ...current, [rule.id]: { ...current[rule.id], match: event.target.value } }))}
              onBlur={() => commitText(rule, "match")}
              className={inputClass}
            />
            <Icon name="ChevronRight" size={16} className="shrink-0 text-fg-2" />
            <input
              aria-label={`Say ${index + 1}`}
              value={edits[rule.id]?.say ?? rule.say}
              onChange={(event) => setEdits((current) => ({ ...current, [rule.id]: { ...current[rule.id], say: event.target.value } }))}
              onBlur={() => commitText(rule, "say")}
              className={inputClass}
            />
            <span className="flex shrink-0 items-center gap-2.5">{flags(rule, index)}</span>
            <button
              type="button"
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => removeRule(rule)}
              className="tap grid size-9 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-raised hover:text-danger"
            >
              <Icon name="X" size={18} />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setDraftOpen((open) => !open)}
          aria-expanded={draftOpen}
          className={outlinePill}
        >
          <Icon name="Plus" size={18} />
          Add rule
        </button>
        {data?.can_suggest && (
          <button type="button" onClick={() => suggest.mutate()} disabled={suggesting} className={outlinePill}>
            <Icon name="Speech" size={18} />
            {suggesting ? "Suggesting…" : "Suggest rules"}
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <section aria-label="Suggested rules" className="mt-2 flex flex-col gap-1.5 rounded-lg bg-raised p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-md font-semibold">Suggested · {suggestions.length}</span>
            <button
              type="button"
              onClick={() => suggestions.forEach(accept)}
              className={outlinePill}
            >
              Accept all
            </button>
          </div>
          <p className="text-sm text-fg-2">
            From the language model. Nothing changes how the book sounds until you accept it.
          </p>
          <ul className="flex flex-col gap-1.5">
            {suggestions.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2.5">
                <span className="min-w-24 flex-1 truncate text-md font-medium">{rule.match}</span>
                <Icon name="ChevronRight" size={16} className="shrink-0 text-fg-2" />
                <input
                  aria-label={`Say ${rule.match}`}
                  value={edits[rule.id]?.say ?? rule.say}
                  onChange={(event) => setEdits((current) => ({ ...current, [rule.id]: { ...current[rule.id], say: event.target.value } }))}
                  onBlur={() => commitText(rule, "say")}
                  className={inputClass}
                />
                <button
                  type="button"
                  aria-label={`Accept ${rule.match}`}
                  onClick={() => accept(rule)}
                  className="tap grid size-9 shrink-0 place-items-center rounded-full text-fg hover:bg-border"
                >
                  <Icon name="Check" size={18} />
                </button>
                <button
                  type="button"
                  aria-label={`Dismiss ${rule.match}`}
                  onClick={() => removeRule(rule)}
                  className="tap grid size-9 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-border hover:text-danger"
                >
                  <Icon name="X" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {draftOpen && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg bg-raised p-2">
          <input
            aria-label="New match"
            placeholder="Text to match"
            value={draft.match}
            onChange={(event) => setDraft((current) => ({ ...current, match: event.target.value }))}
            className={inputClass}
          />
          <Icon name="ChevronRight" size={16} className="shrink-0 text-fg-2" />
          <input
            aria-label="New say"
            placeholder="Replacement"
            value={draft.say}
            onChange={(event) => setDraft((current) => ({ ...current, say: event.target.value }))}
            className={inputClass}
          />
          <span className="flex shrink-0 items-center gap-2.5">
            {(["whole_word", "after_number", "case_sensitive"] as const).map((field) => (
              <label key={field} className="flex items-center gap-1 text-xs text-fg-2">
                <input
                  type="checkbox"
                  aria-label={`New rule ${field.replace(/_/g, " ")}`}
                  checked={draft[field]}
                  onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.checked }))}
                  className="size-4 accent-accent"
                />
                {field.replace(/_/g, " ")}
              </label>
            ))}
          </span>
          <button
            type="button"
            onClick={() => {
              if (addRule()) setDraftOpen(false);
            }}
            disabled={add.isPending}
            className="tap inline-flex h-10 shrink-0 items-center rounded-full bg-fg px-4 text-base font-bold text-on-fg disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {saved && !error && <p aria-live="polite" className="text-sm text-fg-2">Saved</p>}
    </div>
  );
}

const outlinePill =
  "tap inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
