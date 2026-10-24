import { useState, type DragEvent } from "react";
import clsx from "clsx";
import { Upload } from "lucide-react";

/** Drag-and-drop zone wrapping a hidden file input; the whole label is the
 * touch target and opens the picker on tap. */
export function UploadDropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) onFiles(files);
  }

  return (
    <label
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      className={clsx(
        "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-6 text-center",
        dragging ? "border-brand-blue bg-card" : "border-line bg-card/60",
      )}
    >
      <Upload size={28} strokeWidth={1.75} aria-hidden className="text-brand-blue" />
      <span className="font-medium">Drop files here or tap to browse</span>
      <span className="text-sm text-muted">EPUB, PDF, MOBI, AZW, AZW3 — several files at once</span>
      <input
        type="file"
        multiple
        accept=".epub,.pdf,.mobi,.azw,.azw3"
        className="sr-only"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) onFiles(files);
          event.target.value = "";
        }}
      />
    </label>
  );
}
