/** Narrator voice dialog (Direction D): opened only from the book page ⋮
 * menu — the single place a book's narrator is chosen. Lists the voices for
 * the book's language (never the engine's `tts` pseudo-voice) with a Preview
 * play/pause button each, and "Use my default for {language}" to clear the
 * per-book override. Selecting a voice PATCHes the book and closes. */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { previewVoice, useVoices, voiceLabel, voiceOnServer } from "../api/voices";
import { languageName } from "../api/books";
import { Icon } from "./Icon";

export function NarratorVoiceDialog({
  value,
  language,
  error,
  onClose,
  onSelect,
}: {
  /** Saved per-book voice id, or null when the language default is used. */
  value: string | null;
  language: string;
  error?: string | null;
  onClose: () => void;
  onSelect: (voice: string | null) => void;
}) {
  const { data, isPending } = useVoices();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const sample = useRef<{ voice: string; url: string; audio: HTMLAudioElement } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  function stopPreview() {
    if (sample.current) {
      sample.current.audio.pause();
      URL.revokeObjectURL(sample.current.url);
      sample.current = null;
    }
  }
  useEffect(() => stopPreview, []);
  // A modal takes focus on open, so Escape (handled inside) and Tab work at once.
  useEffect(() => closeRef.current?.focus(), []);

  function close() {
    stopPreview();
    onClose();
  }

  const base = language.split("-")[0]!.toLowerCase();
  const options = (data?.items ?? []).filter(
    (voice) => voice.id !== "tts" && voice.language?.split("-")[0]?.toLowerCase() === base,
  );

  async function togglePreview(voiceId: string) {
    setPreviewFailed(false);
    if (sample.current?.voice === voiceId) {
      stopPreview();
      setPreviewing(null);
      return;
    }
    stopPreview();
    try {
      const url = await previewVoice(voiceId);
      const audio = new Audio(url);
      sample.current = { voice: voiceId, url, audio };
      setPreviewing(voiceId);
      audio.addEventListener("ended", () => {
        if (sample.current?.url === url) {
          URL.revokeObjectURL(url);
          sample.current = null;
          setPreviewing(null);
        }
      });
      audio.play().catch(() => {
        setPreviewFailed(true);
        setPreviewing(null);
      });
    } catch {
      setPreviewFailed(true);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 cursor-default bg-bg/70"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Narrator voice"
        className="relative flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-menu)"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl">Narrator voice</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={close}
            className="tap grid size-11 place-items-center rounded-full text-fg-2 hover:bg-raised"
          >
            <Icon name="X" size={20} />
          </button>
        </div>
        <p className="text-base text-fg-2">This book’s narrator. Per-language defaults live in Settings → Voices.</p>

        {isPending ? (
          <p className="py-2 text-md text-fg-2">Loading voices…</p>
        ) : options.length === 0 ? (
          <p className="py-2 text-md text-fg-2">No voices available for this language</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {options.map((voice) => (
              <li key={voice.id} className="flex items-center gap-2">
                <button
                  type="button"
                  aria-pressed={voice.id === value}
                  disabled={!voiceOnServer(voice)}
                  onClick={() => {
                    close();
                    if (voice.id !== value) onSelect(voice.id);
                  }}
                  className={clsx(
                    "tap flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left text-md hover:bg-raised disabled:opacity-50",
                    voice.id === value && "bg-raised font-bold",
                  )}
                >
                  <Icon
                    name="Check"
                    size={18}
                    className={clsx("shrink-0", voice.id === value ? "text-accent" : "invisible")}
                  />
                  <span className="min-w-0 truncate">{voiceLabel(voice)}</span>
                  {!voiceOnServer(voice) && <span className="text-sm text-fg-2">(no longer available)</span>}
                </button>
                <button
                  type="button"
                  aria-label={`Preview ${voiceLabel(voice)}`}
                  onClick={() => void togglePreview(voice.id)}
                  className="tap grid size-11 shrink-0 place-items-center rounded-full border border-border text-fg hover:bg-raised"
                >
                  <Icon name={previewing === voice.id ? "Pause" : "Play"} size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => {
            close();
            if (value !== null) onSelect(null);
          }}
          aria-pressed={value === null}
          className="tap mt-1 flex min-h-11 items-center rounded-lg px-3 text-left text-md font-semibold hover:bg-raised"
        >
          Use my default for {languageName(base)}
        </button>

        {(error || previewFailed) && (
          <p role="alert" className="text-sm text-danger">
            {error ?? "Preview failed."}
          </p>
        )}
      </div>
    </div>
  );
}
