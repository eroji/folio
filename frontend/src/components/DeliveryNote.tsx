/** Book → Manage → Delivery note: how this book should be narrated (tone,
 * pace, setting). Written by the language model's suggestions or by hand; a
 * hand edit is protected from later suggestions (locked_fields). It reaches
 * the speech engine with the voice's style prompt only when the engine takes
 * style prompts, so the note says when it is kept but not sent. */
import { useEffect, useState } from "react";
import type { Book } from "../api/types";
import { useUpdateBook } from "../api/metadata";
import { usePronunciationRules } from "../api/pronunciation";

const MAX = 600;

export function DeliveryNote({ book }: { book: Book }) {
  const update = useUpdateBook(book.id);
  const { data } = usePronunciationRules(book.id);
  const saved = book.delivery_note ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft.trim() !== saved;
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Delivery note"
        rows={3}
        maxLength={MAX}
        placeholder="Quiet and unhurried; let the dialogue stay warm and wry."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="tap w-full resize-y rounded-[18px] border border-border bg-raised px-[18px] py-3 text-[15px] leading-[1.55] text-fg placeholder:text-fg-2"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-2">
          {data?.style_prompts === false
            ? "Kept, but not sent: this server’s speech engine has style prompts off."
            : "Sent with the narrator’s style prompt."}{" "}
          {draft.length} / {MAX}
        </span>
        <button
          type="button"
          disabled={!dirty || update.isPending}
          onClick={() => update.mutate({ delivery_note: draft.trim() || null })}
          className="tap inline-flex h-9 shrink-0 items-center rounded-full bg-fg px-[18px] text-base font-bold text-on-fg hover:opacity-90 disabled:opacity-50"
        >
          Save note
        </button>
      </div>
      {update.isError && (
        <p role="alert" className="text-sm text-danger">
          {update.error.message}
        </p>
      )}
    </div>
  );
}
