import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { useBook, useUpload } from "../api/books";
import { UploadDropzone } from "../components/UploadDropzone";
import { Icon, type IconName } from "../components/Icon";
import type { BookStatus } from "../api/types";

type Row =
  | { key: number; name: string; size: number; state: "uploading"; progress: number }
  | { key: number; name: string; size: number; state: "processing"; bookId: string }
  | { key: number; name: string; size: number; state: "duplicate"; duplicateOf: string }
  | { key: number; name: string; size: number; state: "error"; message: string };

const KINDLE_EXT = /\.(mobi|azw3?|kfx)$/i;

function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One "This session" row: file icon, name · size, status line, action. */
function RowFrame({
  row,
  icon,
  iconClass,
  status,
  statusClass,
  action,
  bar,
}: {
  row: Row;
  icon: IconName;
  iconClass: string;
  status: ReactNode;
  statusClass: string;
  action?: ReactNode;
  bar?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1.5 border-t border-divider py-3">
      <div className="flex items-center gap-2.5">
        <Icon name={icon} className={clsx("shrink-0", iconClass)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-medium">
            {row.name} <span className="font-normal text-fg-2">· {formatSize(row.size)}</span>
          </span>
          <span className={clsx("text-sm", statusClass)}>{status}</span>
        </div>
        {action}
      </div>
      {bar}
    </li>
  );
}

function OpenBook({ bookId }: { bookId: string }) {
  return (
    <Link
      to={`/books/${bookId}`}
      className="tap inline-flex shrink-0 items-center whitespace-nowrap text-sm font-semibold text-accent-fg"
    >
      Open book
    </Link>
  );
}

function IndeterminateBar({ name }: { name: string }) {
  return (
    <div role="progressbar" aria-label={name} className="h-1 overflow-hidden rounded-xs bg-track">
      <div className="bar-indeterminate" />
    </div>
  );
}

/** Live status for an uploaded file: SSE frames invalidate ["book", id],
 * so this refetches and the row flips without a reload. */
function BookRow({
  row,
  onStatus,
  onRemove,
}: {
  row: Extract<Row, { state: "processing" }>;
  onStatus: (bookId: string, status: BookStatus) => void;
  onRemove: (key: number) => void;
}) {
  const { data } = useBook(row.bookId);
  const book = data?.book;
  const status = book?.status ?? "processing";
  useEffect(() => onStatus(row.bookId, status), [row.bookId, status, onStatus]);

  if (status === "ready") {
    const chapters = data?.chapters.length ?? 0;
    return (
      <RowFrame
        row={row}
        icon="task_alt"
        iconClass="text-success"
        status={`Ready · ${chapters} chapter${chapters === 1 ? "" : "s"}`}
        statusClass="text-success"
        action={<OpenBook bookId={row.bookId} />}
      />
    );
  }
  if (status === "needs_ocr") {
    return (
      <RowFrame
        row={row}
        icon="error"
        iconClass="text-warning"
        status="Added · scanned PDF, needs OCR before it can be narrated"
        statusClass="text-warning"
        action={<OpenBook bookId={row.bookId} />}
      />
    );
  }
  if (status === "failed") {
    return (
      <RowFrame
        row={row}
        icon="error"
        iconClass="text-danger"
        status={`Couldn’t add · ${book?.error ?? "The file couldn’t be processed."}`}
        statusClass="text-danger"
        action={
          <button
            type="button"
            aria-label={`Remove ${row.name}`}
            onClick={() => onRemove(row.key)}
            className="tap inline-flex shrink-0 items-center rounded-md px-2.5 text-sm text-fg-2 hover:bg-raised"
          >
            Remove
          </button>
        }
      />
    );
  }
  const converting = KINDLE_EXT.test(row.name);
  return (
    <RowFrame
      row={row}
      icon={converting ? "restart_alt" : "upload"}
      iconClass="text-fg-2"
      status={converting ? "Converting Kindle file to EPUB…" : "Processing…"}
      statusClass="text-fg-2"
      bar={<IndeterminateBar name={row.name} />}
    />
  );
}

/** Screen 3, restyled to the handoff "Upload" reference. */
export function UploadPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [bookStatuses, setBookStatuses] = useState<Record<string, BookStatus>>({});
  const { upload } = useUpload();
  const nextKey = useRef(0);

  const onStatus = useCallback((bookId: string, status: BookStatus) => {
    setBookStatuses((prev) => (prev[bookId] === status ? prev : { ...prev, [bookId]: status }));
  }, []);

  function removeRow(key: number) {
    setRows((prev) => prev.filter((row) => row.key !== key));
  }

  function addFiles(files: File[]) {
    const start = nextKey.current;
    nextKey.current += files.length;
    setRows((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        key: start + i,
        name: file.name,
        size: file.size,
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
                  ? { key, name: file.name, size: file.size, state: "duplicate", duplicateOf: result.duplicate_of }
                  : { key, name: file.name, size: file.size, state: "processing", bookId: result.book_id }
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
                    size: file.size,
                    state: "error",
                    message: error instanceof Error ? error.message : "Something went wrong.",
                  }
                : row,
            ),
          ),
      );
    });
  }

  let inProgress = 0;
  let added = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.state === "uploading") inProgress += 1;
    else if (row.state === "duplicate") added += 1;
    else if (row.state === "error") failed += 1;
    else {
      const status = bookStatuses[row.bookId];
      if (status === "ready" || status === "needs_ocr") added += 1;
      else if (status === "failed") failed += 1;
      else inProgress += 1;
    }
  }
  const summary = [
    inProgress > 0 && `${inProgress} in progress`,
    added > 0 && `${added} added`,
    failed > 0 && `${failed} failed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-xl font-bold tracking-[-0.01em]">Upload books</h1>
      <UploadDropzone onFiles={addFiles} />
      <section aria-label="This session" className="flex flex-col">
        <div className="flex items-baseline justify-between gap-3 border-b border-divider pb-2">
          <h2 className="text-md font-semibold">This session</h2>
          {rows.length > 0 && (
            <span role="status" aria-live="polite" className="text-xs text-fg-2">
              {summary}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-fg-2">Nothing uploaded yet — files you add in this session appear here.</p>
        ) : (
          <ul>
            {rows.map((row) =>
              row.state === "uploading" ? (
                <RowFrame
                  key={row.key}
                  row={row}
                  icon="upload"
                  iconClass="text-fg-2"
                  status={`Uploading · ${row.progress}%`}
                  statusClass="text-fg-2"
                  bar={
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${row.name}`}
                      aria-valuenow={row.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-1 overflow-hidden rounded-xs bg-track"
                    >
                      <div
                        className="h-full rounded-xs bg-progress transition-[width]"
                        style={{ width: `${row.progress}%` }}
                      />
                    </div>
                  }
                />
              ) : row.state === "processing" ? (
                <BookRow key={row.key} row={row} onStatus={onStatus} onRemove={removeRow} />
              ) : row.state === "duplicate" ? (
                <RowFrame
                  key={row.key}
                  row={row}
                  icon="auto_stories"
                  iconClass="text-fg-2"
                  status="Already in your library"
                  statusClass="text-fg-2"
                  action={<OpenBook bookId={row.duplicateOf} />}
                />
              ) : (
                <RowFrame
                  key={row.key}
                  row={row}
                  icon="error"
                  iconClass="text-danger"
                  status={`Couldn’t add · ${row.message}`}
                  statusClass="text-danger"
                  action={
                    <button
                      type="button"
                      aria-label={`Remove ${row.name}`}
                      onClick={() => removeRow(row.key)}
                      className="tap inline-flex shrink-0 items-center rounded-md px-2.5 text-sm text-fg-2 hover:bg-raised"
                    >
                      Remove
                    </button>
                  }
                />
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
