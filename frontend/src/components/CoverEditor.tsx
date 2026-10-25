import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { useUploadCover, useSetCoverUrl } from "../api/metadata";
import { Icon } from "./Icon";
import type { Book } from "../api/types";

const VW = 240;
const VH = 360; // 2:3 crop viewport, CSS px
const OUT_W = 1200;
const OUT_H = 1800; // pinned export size
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

interface Pan {
  x: number;
  y: number;
}

/** Smallest scale at which the image still covers the viewport. */
function fitScale(img: HTMLImageElement): number {
  return Math.max(VW / img.naturalWidth, VH / img.naturalHeight);
}

function clampPan(next: Pan, img: HTMLImageElement, scale: number): Pan {
  return {
    x: Math.min(0, Math.max(VW - img.naturalWidth * scale, next.x)),
    y: Math.min(0, Math.max(VH - img.naturalHeight * scale, next.y)),
  };
}

/** Render the current view at 1200x1800 and encode WebP.
 * ponytail: browsers without WebP encoding fall back to PNG here; the server
 * magic-byte-checks and accepts both. */
function cropToWebp(img: HTMLImageElement, zoom: number, pan: Pan): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  const scale = fitScale(img) * zoom;
  ctx.drawImage(img, -pan.x / scale, -pan.y / scale, VW / scale, VH / scale, 0, 0, OUT_W, OUT_H);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/webp", 0.9));
}

const inputClass = "tap h-10 min-w-0 flex-1 rounded-full border border-border bg-raised px-4 text-md";
const buttonClass =
  "tap inline-flex h-10 items-center rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const primaryButtonClass =
  "tap inline-flex h-10 items-center rounded-full bg-fg px-4 text-base font-bold text-on-fg disabled:opacity-50";

/** Change-cover dialog body (handoff "Manage → Cover"): upload, paste URL,
 * and a 2:3 canvas crop. The dialog chrome (title, close) is the caller's. */
export function CoverEditor({ book, className }: { book: Book; className?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [cropped, setCropped] = useState<{ blob: Blob; url: string } | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; pan: Pan } | null>(null);
  const upload = useUploadCover(book.id);
  const fromUrl = useSetCoverUrl(book.id);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scale = fitScale(img) * zoom;
    ctx.clearRect(0, 0, VW, VH);
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, pan.x, pan.y, img.naturalWidth * scale, img.naturalHeight * scale);
  }, [img, zoom, pan]);

  function pickFile(candidate: File | null) {
    if (!candidate) return;
    setCropped(null);
    setImg(null);
    if (!TYPES.includes(candidate.type)) {
      setFileError("Covers must be JPEG, PNG or WebP images.");
      setFile(null);
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setFileError("Cover image is larger than 10 MB.");
      setFile(null);
      return;
    }
    setFileError(null);
    setFile(candidate);
    setZoom(1);
    const image = new Image();
    image.onload = () => {
      const scale = fitScale(image);
      setPan({ x: (VW - image.naturalWidth * scale) / 2, y: (VH - image.naturalHeight * scale) / 2 });
      setImg(image);
    };
    image.src = URL.createObjectURL(candidate);
  }

  function saveBlob(blob: Blob, filename: string, then?: () => void) {
    upload.mutate(
      { file: blob, filename },
      {
        onSuccess: () => {
          then?.();
        },
      },
    );
  }

  const error = fileError ?? upload.error?.message ?? fromUrl.error?.message ?? null;

  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start gap-4">
        {book.cover_url ? (
          <img src={book.cover_url} alt="" className="aspect-[2/3] w-32 rounded-md bg-raised object-cover" />
        ) : (
          <div className="grid aspect-[2/3] w-32 place-items-center rounded-md border border-border bg-raised text-sm text-fg-2">
            No cover
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="flex flex-col gap-1 text-base font-medium">
            Upload image
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="tap min-h-9 text-base font-normal"
              onChange={(event) => {
                pickFile(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="url"
              aria-label="Cover image URL"
              placeholder="https://example.org/cover.jpg"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              className={inputClass}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={!urlInput.trim() || fromUrl.isPending}
              onClick={() => fromUrl.mutate(urlInput.trim())}
            >
              Fetch URL
            </button>
          </div>
        </div>
      </div>

      {img && (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <canvas
            ref={canvasRef}
            width={VW}
            height={VH}
            aria-label="Crop area. Drag to move the image."
            className="aspect-[2/3] w-60 touch-none rounded-md bg-raised"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, pan };
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const scale = fitScale(img) * zoom;
              setPan(
                clampPan(
                  {
                    x: drag.current.pan.x + event.clientX - drag.current.x,
                    y: drag.current.pan.y + event.clientY - drag.current.y,
                  },
                  img,
                  scale,
                ),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          />
          <div className="flex min-w-40 flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1 text-base font-medium">
              Zoom
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setZoom(next);
                  setPan((current) => clampPan(current, img, fitScale(img) * next));
                }}
                className="accent-progress"
              />
            </label>
            {file && (
              <button type="button" className={buttonClass} disabled={upload.isPending} onClick={() => saveBlob(file, file.name)}>
                Upload as-is
              </button>
            )}
            <button
              type="button"
              className={primaryButtonClass}
              disabled={upload.isPending}
              onClick={() => {
                void cropToWebp(img, zoom, pan).then((blob) => {
                  if (blob) setCropped({ blob, url: URL.createObjectURL(blob) });
                });
              }}
            >
              Crop to 2:3
            </button>
          </div>
        </div>
      )}

      {cropped && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <img src={cropped.url} alt="Cropped cover preview" className="aspect-[2/3] w-32 rounded-md bg-raised object-cover" />
          <div className="flex gap-2">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={upload.isPending}
              onClick={() =>
                saveBlob(cropped.blob, "cover.webp", () => {
                  URL.revokeObjectURL(cropped.url);
                  setCropped(null);
                  setImg(null);
                  setFile(null);
                })
              }
            >
              Save cover
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                URL.revokeObjectURL(cropped.url);
                setCropped(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-center gap-2 rounded-lg border border-danger bg-surface px-3 py-2 text-sm text-danger">
          <Icon name="error" size={16} />
          {error}
        </p>
      )}
      {fromUrl.isSuccess && (
        <p role="status" className="mt-3 text-sm text-fg-2">
          Cover updated from URL. <Link to={`/books/${book.id}`} className="text-fg underline">View book</Link>
        </p>
      )}
    </div>
  );
}
