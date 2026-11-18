/** ⋮ book menu with its dialogs and progress mutations wired — the piece
 * every book row (Library list view, Search results) repeats. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  continueQueryKey,
  finishedQueryKey,
  markFinished,
  progressQueryKey,
  resetProgress,
} from "../api/progress";
import { useUpdateBook } from "../api/metadata";
import type { Book, Progress } from "../api/types";
import { BookMenu } from "./BookMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { NarratorVoiceDialog } from "./NarratorVoiceDialog";

export function BookRowMenu({ book, progress }: { book: Book; progress: Progress | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);
  const [narratorOpen, setNarratorOpen] = useState(false);
  const toggleFinished = useMutation({
    mutationFn: (value: boolean) => markFinished(book.id, value),
    onSuccess: () => invalidate(),
  });
  const reset = useMutation({ mutationFn: () => resetProgress(book.id), onSuccess: () => invalidate() });
  const narratorUpdate = useUpdateBook(book.id);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["books"] });
    void queryClient.invalidateQueries({ queryKey: ["search"] });
    void queryClient.invalidateQueries({ queryKey: continueQueryKey });
    void queryClient.invalidateQueries({ queryKey: finishedQueryKey });
  }

  return (
    <>
      <BookMenu
        finished={Boolean(progress?.finished_at)}
        pending={toggleFinished.isPending}
        bookTitle={book.title}
        onToggleFinished={(value) => toggleFinished.mutate(value)}
        onReset={() => setResetOpen(true)}
        // PATCH /books/{id} is admin/uploader only: others never see an item that would 403.
        onNarrator={book.can_edit ? () => setNarratorOpen(true) : undefined}
        onGoToAuthor={() =>
          navigate(book.authors[0] ? `/search?q=${encodeURIComponent(book.authors[0])}` : "/search")
        }
      />
      {resetOpen && (
        <ConfirmDialog
          title={`Reset your progress in ${book.title}?`}
          description="This cannot be undone."
          confirmLabel="Reset"
          busy={reset.isPending}
          onCancel={() => setResetOpen(false)}
          onConfirm={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                localStorage.removeItem(`folio-pos-${book.id}`);
                void queryClient.invalidateQueries({ queryKey: progressQueryKey(book.id) });
                invalidate();
                setResetOpen(false);
              },
            })
          }
        />
      )}
      {narratorOpen && (
        <NarratorVoiceDialog
          value={book.narrator_voice}
          language={book.language}
          error={narratorUpdate.isError ? narratorUpdate.error.message : null}
          onClose={() => setNarratorOpen(false)}
          onSelect={(next) =>
            narratorUpdate.mutate(
              { narrator_voice: next },
              {
                onSuccess: () => {
                  invalidate();
                  setNarratorOpen(false);
                },
              },
            )
          }
        />
      )}
    </>
  );
}
