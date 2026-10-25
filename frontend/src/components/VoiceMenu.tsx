/** Narrator voice popover for the book page hero: anchored to the borderless
 * voice button, lists the book-language voices (never the engine's `tts`
 * pseudo-voice) as menuitemradio rows labelled by display_name, falling back
 * to the parsed id ("ashley-en" → "Ashley"). Selecting PATCHes the book and
 * closes; Preview plays the focused (or current) voice without selecting it.
 * Keyboard pattern matches BookMenu: arrows cycle, Escape closes and returns
 * focus to the trigger. */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { previewVoice, useVoices, voiceDisplayName } from "../api/voices";
import { Icon } from "./Icon";

interface VoiceMenuProps {
  /** Effective voice id (saved choice or settings default), or null. */
  value: string | null;
  language: string;
  /** Message from a failed narrator_voice PATCH, shown while the menu is open. */
  error?: string | null;
  /** Rendered at the desktop breakpoint (smaller trigger/icon). */
  desktop: boolean;
  onChange: (voice: string) => void;
}

export function VoiceMenu({ value, language, error, desktop, onChange }: VoiceMenuProps) {
  const { data, isPending } = useVoices();
  const [open, setOpen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const previewTarget = useRef<string | null>(null);
  const sample = useRef<{ url: string; audio: HTMLAudioElement } | null>(null);

  function stopPreview() {
    if (sample.current) {
      sample.current.audio.pause();
      URL.revokeObjectURL(sample.current.url);
      sample.current = null;
    }
  }
  useEffect(() => stopPreview, []);

  function close(restoreFocus = true) {
    setOpen(false);
    stopPreview();
    if (restoreFocus) triggerRef.current?.focus();
  }

  const base = language.split("-")[0]!.toLowerCase();
  // Untagged voices and the engine's "tts" pseudo-voice are never options.
  const options = (data?.items ?? []).filter(
    (voice) => voice.id !== "tts" && voice.language?.split("-")[0]?.toLowerCase() === base,
  );

  async function preview() {
    const target = previewTarget.current ?? value ?? options.find((voice) => voice.available)?.id;
    if (!target) return;
    setPreviewFailed(false);
    stopPreview();
    try {
      const url = await previewVoice(target);
      const audio = new Audio(url);
      sample.current = { url, audio };
      audio.addEventListener("ended", () => {
        if (sample.current?.url === url) {
          URL.revokeObjectURL(url);
          sample.current = null;
        }
      });
      audio.play().catch(() => setPreviewFailed(true));
    } catch {
      setPreviewFailed(true);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    const items = itemsRef.current
      ? Array.from(itemsRef.current.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      : [];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focus = (next: number) => {
      event.preventDefault();
      items[((next % items.length) + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(items.length - 1);
  }

  return (
    <div className="relative shrink-0" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Narrator voice: ${value ?? "default"}`}
        title="Narrator voice"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="tap grid size-11 place-items-center rounded-md text-fg hover:bg-raised desktop:size-9"
      >
        <Icon name="record_voice_over" size={desktop ? 20 : 22} />
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => close(false)}
          />
          <div
            ref={itemsRef}
            role="menu"
            aria-label="Narrator voice"
            className="absolute top-full right-0 z-40 w-max min-w-44 rounded-lg border border-divider bg-surface p-1 shadow-(--shadow-menu)"
          >
            {isPending ? (
              <p className="px-3 py-2 text-sm text-fg-2">Loading voices…</p>
            ) : options.length === 0 ? (
              <p className="px-3 py-2 text-sm text-fg-2">No voices available for this language</p>
            ) : (
              options.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={voice.id === value}
                  disabled={!voice.available}
                  onFocus={() => {
                    previewTarget.current = voice.id;
                  }}
                  onClick={() => {
                    close(false);
                    if (voice.id !== value) onChange(voice.id);
                  }}
                  className="tap flex min-h-[34px] w-full items-center gap-2 rounded-md pr-3 pl-2 text-left text-base whitespace-nowrap hover:bg-raised disabled:opacity-50 desktop:min-h-[30px]"
                >
                  <Icon name="check" size={18} className={voice.id === value ? "shrink-0" : "invisible shrink-0"} />
                  <span className="min-w-0 truncate">{voiceDisplayName(voice)}</span>
                  {!voice.available && <span className="text-xs text-fg-2">(No longer available)</span>}
                </button>
              ))
            )}
            <div className={options.length > 0 ? "mt-1 border-t border-divider pt-1" : ""}>
              <button
                type="button"
                onClick={() => void preview()}
                disabled={options.length === 0}
                className="tap flex min-h-[34px] w-full items-center gap-2 rounded-md pr-3 pl-2 text-left text-base whitespace-nowrap hover:bg-raised disabled:opacity-50 desktop:min-h-[30px]"
              >
                <Icon name="play_arrow" size={18} />
                Preview
              </button>
            </div>
            {error && (
              <p role="alert" className="px-3 pb-1 text-sm text-danger">
                {error}
              </p>
            )}
            {previewFailed && (
              <p role="alert" className="px-3 pb-1 text-sm text-danger">
                Preview failed.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
