import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { groupVoicesByLanguage, previewVoice, useVoices } from "../api/voices";

interface VoicePickerProps {
  /** Saved voice id, or null when the user has not picked one yet. */
  value: string | null;
  language: string;
  onChange: (voice: string) => void;
}

/** Screen 8 / Screen 4 voice dropdown: only voices for the language, a
 * Preview button for the selected voice, and a "No longer available" note
 * when the saved voice left the engine. With nothing saved (or a saved
 * voice that is gone) the first available voice of the language is shown
 * as selected, but nothing is written back until the user picks one. */
export function VoicePicker({ value, language, onChange }: VoicePickerProps) {
  const { data, isPending } = useVoices();
  const [previewFailed, setPreviewFailed] = useState(false);
  const sample = useRef<{ url: string; audio: HTMLAudioElement } | null>(null);

  useEffect(
    () => () => {
      if (sample.current) {
        sample.current.audio.pause();
        URL.revokeObjectURL(sample.current.url);
      }
    },
    [],
  );

  const voices = data?.items ?? [];
  const groups = groupVoicesByLanguage(voices);
  const base = language.split("-")[0]!.toLowerCase();
  // Untagged voices land in groups.any and are excluded; the engine's "tts"
  // pseudo-voice is filtered defensively even if the API tags it.
  const options = (groups[base] ?? []).filter((voice) => voice.id !== "tts");
  const saved = value ? options.find((voice) => voice.id === value) : undefined;
  const unavailable = !isPending && Boolean(value) && (!saved || !saved.available);
  const selected = saved?.available ? saved.id : (options.find((v) => v.available)?.id ?? "");
  const empty = !isPending && options.length === 0;

  async function preview() {
    if (!selected) return;
    setPreviewFailed(false);
    try {
      const url = await previewVoice(selected);
      if (sample.current) {
        sample.current.audio.pause();
        URL.revokeObjectURL(sample.current.url);
      }
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={`${language} voice`}
        value={selected}
        onChange={(event) => onChange(event.target.value)}
        disabled={empty}
        className="min-h-11 max-w-full rounded-card border border-line bg-card px-3 text-sm"
      >
        {empty ? (
          <option value="">No voices available for this language</option>
        ) : (
          options.map((voice) => (
            <option key={voice.id} value={voice.id} disabled={!voice.available}>
              {voice.id}
              {voice.description ? ` — ${voice.description}` : ""}
              {voice.available ? "" : " (No longer available)"}
            </option>
          ))
        )}
      </select>
      {!empty && (
        <button
          type="button"
          onClick={preview}
          disabled={!selected}
          className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
        >
          <Volume2 size={18} strokeWidth={1.75} aria-hidden />
          Preview
        </button>
      )}
      {unavailable && (
        <p className="w-full text-sm text-danger">
          “{value}” is no longer available on the TTS engine.
        </p>
      )}
      {previewFailed && (
        <p role="alert" className="w-full text-sm text-danger">
          Preview failed.
        </p>
      )}
    </div>
  );
}
