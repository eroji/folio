import { useState, type DragEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import folioMark from "../assets/folio-mark.svg";

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
        "flex cursor-pointer flex-col items-center gap-3.5 rounded-2xl border-2 border-dashed bg-fg/[0.02] px-6 py-12 text-center",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        dragging ? "border-accent" : "border-control-border",
      )}
    >
      <img src={folioMark} alt="" width={56} height={56} aria-hidden />
      <span className="font-display text-xl">Drop books here</span>
      <span className="text-md text-fg-2">
        EPUB, PDF, MOBI, AZW or AZW3 · up to 200 MB each · no DRM or KFX
      </span>
      <span className="tap inline-flex h-11 items-center gap-2 rounded-full bg-fg px-[18px] text-md font-bold text-on-fg">
        <Icon name="Upload" size={20} />
        Choose files
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
