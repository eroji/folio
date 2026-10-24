import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useBook, useUpload } from "../api/books";
import { UploadDropzone } from "../components/UploadDropzone";
import { StatusBadge } from "../components/StatusBadge";

type Row =
  | { key: number; name: string; state: "uploading"; progress: number }
  | { key: number; name: string; state: "processing"; bookId: string }
  | { key: number; name: string; state: "duplicate"; duplicateOf: string }
  | { key: number; name: string; state: "error"; message: string };

/** Live status for an uploaded file: SSE frames invalidate ["book", id],
 * so this refetches and the badge flips without a reload. */
function UploadedRow({ name, bookId }: { name: string; bookId: string }) {
  const { data } = useBook(bookId);
  const book = data?.book;
  const status = book?.status ?? "processing";
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Link to={`/books/${bookId}`} className="truncate text-sm font-medium hover:text-brand-blue">
          {book?.title || name}
        </Link>
        <StatusBadge status={status} />
      </div>
      {status === "failed" && book?.error && <p className="text-sm text-danger">{book.error}</p>}
    </>
  );
}

/** Screen 3. */
export function UploadPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const { upload } = useUpload();
  const nextKey = useRef(0);

  function addFiles(files: File[]) {
    const start = nextKey.current;
    nextKey.current += files.length;
    setRows((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        key: start + i,
        name: file.name,
        state: "uploading" as const,
        progress: 0,
      })),
    ]);
    files.forEach((file, i) => {
      const key = start + i;
      upload(file, (progress) =>
        setRows((prev) =>
          prev.map((row) => (row.key === key && row.state === "uploading" ? { ...row, progress } : row)),
        ),
      ).then(
        (result) =>
          setRows((prev) =>
            prev.map((row) =>
              row.key === key
                ? result.duplicate_of
                  ? { key, name: file.name, state: "duplicate", duplicateOf: result.duplicate_of }
                  : { key, name: file.name, state: "processing", bookId: result.book_id }
                : row,
            ),
          ),
        (error: unknown) =>
          setRows((prev) =>
            prev.map((row) =>
              row.key === key
                ? {
                    key,
                    name: file.name,
                    state: "error",
                    message: error instanceof Error ? error.message : "Something went wrong.",
                  }
                : row,
            ),
          ),
      );
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-xl font-semibold">Upload</h1>
      <UploadDropzone onFiles={addFiles} />
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-2 rounded-card border border-line bg-card p-3">
              {row.state === "uploading" && (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    <StatusBadge status="queued" />
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${row.name}`}
                    aria-valuenow={row.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full overflow-hidden rounded-pill bg-page"
                  >
                    <div className="h-full bg-brand-gradient transition-[width]" style={{ width: `${row.progress}%` }} />
                  </div>
                </>
              )}
              {row.state === "processing" && <UploadedRow name={row.name} bookId={row.bookId} />}
              {row.state === "duplicate" && (
                <>
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="text-sm text-muted">
                    Duplicate — already in your library.{" "}
                    <Link to={`/books/${row.duplicateOf}`} className="text-brand-blue underline">
                      Open book
                    </Link>
                  </p>
                </>
              )}
              {row.state === "error" && (
                <>
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p role="alert" className="text-sm text-danger">
                    {row.message}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
