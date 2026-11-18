/** Where a book's narrator is seen and changed: the "Narrated by" row under
 * the book page's primary action and the voice button on the phone player.
 * Both open NarratorVoiceDialog. Only listeners who may edit the book (admin
 * or uploader; PATCH /books/{id} enforces it) can change the voice — everyone
 * else sees who narrates as plain text. */
import { useState } from "react";
import clsx from "clsx";
import { useBook } from "../api/books";
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

/** The voice dialog with its PATCH. The mutation lives in the caller that
 * stays mounted: the dialog closes on select, and per-call callbacks of an
 * unmounted mutation never run (a playing book must switch voice in place). */
function useNarratorDialog(book: Book) {
  const player = usePlayer();
  const update = useUpdateBook(book.id);
  const [open, setOpen] = useState(false);
  const dialog = open ? (
    <NarratorVoiceDialog
      value={book.narrator_voice}
      language={book.language}
      error={update.isError ? update.error.message : null}
      onClose={() => setOpen(false)}
      onSelect={(next) => update.mutate({ narrator_voice: next }, { onSuccess: () => player.reloadVoice(book.id) })}
    />
  ) : null;
  return { openDialog: () => setOpen(true), dialog };
}

/** Book page: a full-width row directly under Play / Resume. */
export function NarratorRow({ book, canChange }: { book: Book; canChange: boolean }) {
  const { label } = useNarrator(book);
  const { openDialog, dialog } = useNarratorDialog(book);
  const text = label ? `Narrated by ${label}` : "Default narrator";
  if (!canChange) {
    return label ? (
      <p className="flex min-h-11 items-center justify-center gap-2 text-base text-fg-2">
        <Icon name="Speech" size={18} />
        <span>{text}</span>
      </p>
    ) : null;
  }
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

/** Phone player: a pill with the voice name in the speed / sleep row. Reads
 * the book through its query so a change shows at once (and so the narrator
 * reload finds the cached book). */
export function VoiceButton({ className }: { className?: string }) {
  const player = usePlayer();
  const { data } = useBook(player.book?.id ?? "");
  const book = data?.book ?? player.book;
  if (!book || !(book.can_edit ?? false)) return null;
  return <VoicePill book={book} className={className} />;
}

function VoicePill({ book, className }: { book: Book; className?: string }) {
  const { label } = useNarrator(book);
  const { openDialog, dialog } = useNarratorDialog(book);
  return (
    <>
      <button
        type="button"
        aria-label={`Narrator voice, ${label ?? "default"}`}
        title="Narrator voice"
        aria-haspopup="dialog"
        onClick={openDialog}
        className={clsx(
          "tap inline-flex h-10 max-w-[160px] items-center gap-2 rounded-full bg-raised px-3.5 text-base font-semibold text-fg hover:bg-border",
          className,
        )}
      >
        <Icon name="Speech" size={18} className="shrink-0" />
        <span className="min-w-0 truncate">{label ?? "Voice"}</span>
      </button>
      {dialog}
    </>
  );
}
