import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useBook, useDeleteBook, useReprocessBook } from "../api/books";
import { useMetadataCandidates } from "../api/metadata";
import { useAuth } from "../auth/AuthProvider";
import { BookCover } from "../components/BookCard";
import { FindMetadata } from "../components/FindMetadata";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { AlertTriangle, BookOpen } from "lucide-react";
import type { Candidate } from "../api/types";

function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Screen 4. Playback arrives in M4; metadata editing in M3. */
export function BookDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isPending, error } = useBook(id);
  const reprocess = useReprocessBook(id);
  const remove = useDeleteBook(id);
  const [findOpen, setFindOpen] = useState(false);
  const [reviewItems, setReviewItems] = useState<Candidate[] | null>(null);
  const candidates = useMetadataCandidates(id);

  if (error instanceof Error) {
    return (
      <EmptyState
        icon={<AlertTriangle size={28} strokeWidth={1.75} aria-hidden />}
        title="Book not found"
        description={error.message}
        action={
          <Link to="/" className="text-sm font-medium text-brand-blue underline">
            Back to library
          </Link>
        }
      />
    );
  }

  if (isPending || !data) {
    return (
      <div className="animate-pulse" aria-busy="true">
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="aspect-[2/3] w-40 rounded-card bg-card md:w-56" />
          <div className="flex-1 space-y-3">
            <div className="h-8 w-2/3 rounded bg-card" />
            <div className="h-4 w-1/2 rounded bg-card" />
            <div className="h-24 rounded-card bg-card" />
          </div>
        </div>
      </div>
    );
  }

  const { book, chapters } = data;
  const saved = candidates.data?.items ?? [];
  const length = formatDuration(book.est_duration_s);
  const series = book.series ? `${book.series}${book.series_index != null ? ` #${book.series_index}` : ""}` : null;

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <BookCover book={book} className="aspect-[2/3] w-40 shrink-0 self-center rounded-card md:w-56" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold">{book.title}</h1>
            <p className="text-muted">{book.authors.join(", ")}</p>
            {series && <p className="text-sm text-muted">{series}</p>}
          </div>
          <StatusBadge status={book.status} />
        </div>

        {book.status === "failed" && book.error && (
          <p role="alert" className="rounded-card border border-danger/40 bg-page px-3 py-2 text-sm text-danger">
            {book.error}
          </p>
        )}

        <p className="text-sm text-muted">
          {[book.language, length && `about ${length}`].filter(Boolean).join(" · ")}
        </p>

        {book.description && (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer font-medium text-brand-blue">Description</summary>
            <p className="whitespace-pre-line text-muted">{book.description}</p>
          </details>
        )}

        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            disabled
            title="Playback arrives in M4"
            className="inline-flex h-12 min-w-40 items-center justify-center gap-2 rounded-pill bg-brand-gradient px-6 font-display font-semibold text-white opacity-50 disabled:cursor-not-allowed"
          >
            <Play size={20} strokeWidth={1.75} aria-hidden />
            Play
          </button>
          <p className="text-xs text-muted">Playback arrives in M4</p>
        </div>

        {/* Edit / Find metadata: shown to every signed-in user; the server enforces
            uploader-or-admin and the 403 message surfaces inline. */}
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/books/${id}/edit`}
            className="inline-flex min-h-11 items-center rounded-pill border border-line bg-card px-4 text-sm font-medium"
          >
            Edit
          </Link>
          <button
            type="button"
            aria-expanded={findOpen}
            onClick={() => {
              setReviewItems(null);
              setFindOpen((open) => !open);
            }}
            className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium"
          >
            Find metadata
          </button>
        </div>

        {saved.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-brand-blue/40 bg-page px-3 py-2">
            <p className="text-sm text-muted">Online matches were found but not applied automatically.</p>
            <button
              type="button"
              onClick={() => {
                setReviewItems(saved);
                setFindOpen(true);
              }}
              className="min-h-11 rounded-pill bg-brand-blue px-4 text-sm font-medium text-white"
            >
              Review metadata matches
            </button>
          </div>
        )}

        {findOpen && <FindMetadata book={book} initialItems={reviewItems ?? undefined} />}

        {/* TODO(M5): the spec also allows the uploader; the Book payload does not expose
            uploaded_by, so until it does only admins see Reprocess/Delete. */}
        {user?.role === "admin" && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                reprocess.mutate(undefined, {
                  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book", id] }),
                })
              }
              disabled={reprocess.isPending}
              className="min-h-11 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
            >
              Reprocess
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete “${book.title}” from the library?`)) {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: ["books"] });
                      navigate("/");
                    },
                  });
                }
              }}
              disabled={remove.isPending}
              className="min-h-11 rounded-pill border border-danger/40 px-4 text-sm font-medium text-danger disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}

        {chapters.length > 0 && (
          <div>
            <h2 className="mb-2 flex items-center gap-2 font-display text-lg font-semibold">
              <BookOpen size={18} strokeWidth={1.75} aria-hidden />
              Chapters
            </h2>
            <ol className="divide-y divide-line rounded-card border border-line bg-card">
              {chapters.map((chapter) => (
                <li key={chapter.id} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0 text-sm">
                    <span className="mr-2 tabular-nums text-muted">{chapter.idx}</span>
                    <span className="truncate">{chapter.title}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {chapter.char_count.toLocaleString()} chars
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
