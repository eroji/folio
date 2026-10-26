/** Modal confirm dialog (Direction D shape): raised surface, pill buttons,
 * danger variant outlined in red. Used by the book page's Reset and Delete. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 cursor-default bg-bg/70"
        onClick={onCancel}
      />
      <div role="dialog" aria-modal="true" aria-label={title} className="relative w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-(--shadow-menu)">
        <p className="font-display text-xl">{title}</p>
        <p className="mt-1 text-md text-fg-2">{description}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="tap inline-flex h-10 flex-1 items-center justify-center rounded-full border border-border px-4 text-base font-semibold text-fg hover:bg-raised"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              danger
                ? "tap inline-flex h-10 flex-1 items-center justify-center rounded-full border border-danger px-4 text-base font-bold text-danger disabled:opacity-50"
                : "tap inline-flex h-10 flex-1 items-center justify-center rounded-full bg-fg px-4 text-base font-bold text-on-fg disabled:opacity-50"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
