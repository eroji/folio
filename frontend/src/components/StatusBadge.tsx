import clsx from "clsx";
import type { BookStatus } from "../api/types";

const LABELS: Record<BookStatus | "queued", string> = {
  queued: "Queued",
  uploading: "Uploading",
  processing: "Processing",
  ready: "Ready",
  needs_ocr: "Needs OCR",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: BookStatus | "queued" }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded-pill border border-line bg-page px-2 py-0.5 text-xs font-medium",
        status === "failed" ? "border-danger/40 text-danger" : status === "ready" ? "text-ink" : "text-muted",
      )}
    >
      {LABELS[status]}
    </span>
  );
}
