/** Where a book's narrator is seen and changed: the "Narrated by" row under
 * the book page's primary action; the player's Narrator control lives in
 * ListeningControls and shares useNarrator / useChangeNarrator.
 * Both open NarratorVoiceDialog. Every signed-in listener picks the voice they
 * hear for this book (PATCH /books/{id} accepts it from anyone); the narrator
 * is never display-only. */
import { useState } from "react";
import { useUpdateBook } from "../api/metadata";
import { useListeningSettings } from "../api/settings";
import { baseLanguage, useVoices, voiceLabel } from "../api/voices";
import type { Book } from "../api/types";
import { usePlayer } from "../player/usePlayer";
import { Icon } from "./Icon";
import { NarratorVoiceDialog } from "./NarratorVoiceDialog";

/** The voice this listener hears for the book, resolved like the server:
 * book narrator → listener's language preference → server default. The label
 * is the admin display name when the voice list has one. */
export function useNarrator(book: Book): { voice: string | null; label: string | null } {
  const { settings } = useListeningSettings();
  const { data } = useVoices();
  const base = baseLanguage(book.language);
  const voice = book.narrator_voice ?? settings.voices[base] ?? data?.defaults?.[base] ?? null;
  if (!voice) return { voice: null, label: null };
  const known = data?.items.find((item) => item.id === voice);
  return { voice, label: voiceLabel(known ?? { id: voice }) };
}

/** The About panel's Narrator row (a <dt>/<dd> pair); nothing when unknown. */
export function NarratorName({ book }: { book: Book }) {
  const { label } = useNarrator(book);
  if (!label) return null;
  return (
    <>
      <dt className="text-md text-fg-2">Narrator</dt>
      <dd className="text-md">{label}</dd>
    </>
  );
}

/** The PATCH behind every narrator picker; a playing book switches voice in
 * place. Call it in a component that stays mounted while the dialog closes:
 * per-call callbacks of an unmounted mutation never run. */
export function useChangeNarrator(book: Book) {
  const player = usePlayer();
  const update = useUpdateBook(book.id);
  return {
    error: update.isError ? update.error.message : null,
    select: (next: string | null) =>
      update.mutate({ narrator_voice: next }, { onSuccess: () => player.reloadVoice(book.id) }),
  };
}

/** The modal voice dialog plus its PATCH, for the book page row. */
function useNarratorDialog(book: Book) {
  const change = useChangeNarrator(book);
  const [open, setOpen] = useState(false);
  const dialog = open ? (
    <NarratorVoiceDialog
      value={book.narrator_voice}
      language={book.language}
      error={change.error}
      onClose={() => setOpen(false)}
      onSelect={change.select}
    />
  ) : null;
  return { openDialog: () => setOpen(true), dialog };
}

/** The modal voice dialog for a menu entry (desktop book page ⋮). Render it
 * always and toggle `open`: the PATCH lives here, so the voice reload still
 * runs after the dialog has closed. */
export function NarratorPicker({ book, open, onClose }: { book: Book; open: boolean; onClose: () => void }) {
  const change = useChangeNarrator(book);
  if (!open) return null;
  return (
    <NarratorVoiceDialog
      value={book.narrator_voice}
      language={book.language}
      error={change.error}
      onClose={onClose}
      onSelect={change.select}
    />
  );
}

/** Phone book page: a full-width row directly under Play / Resume. */
export function NarratorRow({ book }: { book: Book }) {
  const { label } = useNarrator(book);
  const { openDialog, dialog } = useNarratorDialog(book);
  const text = label ? `Narrated by ${label}` : "Default narrator";
  return (
    <>
      <button
        type="button"
        aria-label={`Narrator voice, ${label ?? "default"}`}
        aria-haspopup="dialog"
        onClick={openDialog}
        className="tap flex min-h-12 w-full items-center gap-3 rounded-full border border-border px-4 text-left text-md text-fg hover:bg-raised"
      >
        <Icon name="Speech" size={20} className="shrink-0 text-fg-2" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="shrink-0 text-base font-semibold text-fg-2">Change</span>
        <Icon name="ChevronRight" size={18} className="shrink-0 text-fg-2" />
      </button>
      {dialog}
    </>
  );
}
