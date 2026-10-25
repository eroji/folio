import { useState, type DragEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

/** Drag-and-drop zone wrapping a hidden file input; the whole label is the
 * drop target and opens the picker on tap (handoff "Upload"). */
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
        "flex cursor-pointer flex-col items-center gap-2.5 rounded-lg border-2 border-dashed bg-surface px-5 py-8 text-center",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-progress",
        dragging ? "border-progress" : "border-control-border",
      )}
    >
      <Icon name="upload" size={32} className="text-fg-2" />
      <span className="text-md font-semibold">Drop EPUB, PDF or Kindle files here</span>
      <span className="inline-flex h-9 items-center rounded-md bg-primary-gradient px-3.5 text-base font-semibold">
        Choose files
      </span>
      <span className="text-xs text-fg-2">
        Up to 200 MB each · .epub, .pdf, .mobi, .azw, .azw3 · DRM-protected and KFX files aren’t supported
      </span>
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
