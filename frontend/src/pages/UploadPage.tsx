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

/** Outlined pill action at the right end of a row (reference). */
const pillAction =
  "tap inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border border-border px-4 text-base font-semibold text-fg no-underline hover:bg-raised";

/** One "This session" surface row: status icon, name · size, status text,
 * action right, optional progress bar under. */
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
    <li className="flex flex-col gap-2.5 rounded-xl bg-surface px-4 py-3.5">
      <div className="flex items-center gap-3.5">
        <Icon name={icon} size={22} className={clsx("shrink-0", iconClass)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-md font-semibold">
            {row.name} <span className="font-normal text-fg-2">· {formatSize(row.size)}</span>
          </span>
          <span className={clsx("text-base", statusClass)}>{status}</span>
        </div>
        {action}
      </div>
      {bar}
    </li>
  );
}

function OpenBook({ bookId }: { bookId: string }) {
  return (
    <Link to={`/books/${bookId}`} className={pillAction}>
      Open book
    </Link>
  );
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={`Remove ${name}`} onClick={onClick} className={pillAction}>
      Remove
    </button>
  );
}

function IndeterminateBar({ name }: { name: string }) {
  return (
    <div role="progressbar" aria-label={name} className="h-1 overflow-hidden rounded-full bg-border">
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
        icon="CircleCheck"
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
        icon="TriangleAlert"
        iconClass="text-warning"
        status="Added · scanned PDF, needs OCR"
        statusClass="text-warning"
        action={<OpenBook bookId={row.bookId} />}
      />
    );
  }
  if (status === "failed") {
    return (
      <RowFrame
        row={row}
        icon="TriangleAlert"
        iconClass="text-danger"
        status={`Couldn’t add · ${book?.error ?? "The file couldn’t be processed."}`}
        statusClass="text-danger"
        action={<RemoveButton name={row.name} onClick={() => onRemove(row.key)} />}
      />
    );
  }
  const converting = KINDLE_EXT.test(row.name);
  return (
    <RowFrame
      row={row}
      icon="RefreshCw"
      iconClass="text-fg-2 animate-spin"
      status={converting ? "Converting Kindle file to EPUB…" : "Processing…"}
      statusClass="text-fg-2"
      bar={<IndeterminateBar name={row.name} />}
    />
  );
}

/** Upload (Direction D §4): drop zone plus a "This session" live summary
 * and one surface row per file. */
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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Add to your library</span>
        <h1 className="font-display text-4xl">Upload</h1>
      </div>
      <UploadDropzone onFiles={addFiles} />
      <section aria-label="This session" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-xl">This session</h2>
          {rows.length > 0 && (
            <span role="status" aria-live="polite" className="text-base text-fg-2 tabular">
              {summary}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-fg-2">Nothing uploaded yet — files you add in this session appear here.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) =>
              row.state === "uploading" ? (
                <RowFrame
                  key={row.key}
                  row={row}
                  icon="Upload"
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
                      className="h-1 overflow-hidden rounded-full bg-border"
                    >
                      <div
                        className="h-full rounded-full bg-accent transition-[width]"
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
                  icon="BookOpen"
                  iconClass="text-fg-2"
                  status="Already in your library"
                  statusClass="text-fg-2"
                  action={<OpenBook bookId={row.duplicateOf} />}
                />
              ) : (
                <RowFrame
                  key={row.key}
                  row={row}
                  icon="TriangleAlert"
                  iconClass="text-danger"
                  status={`Couldn’t add · ${row.message}`}
                  statusClass="text-danger"
                  action={<RemoveButton name={row.name} onClick={() => removeRow(row.key)} />}
                />
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
