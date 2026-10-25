import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { groupVoicesByLanguage, previewVoice, useVoices } from "../api/voices";

interface VoicePickerProps {
  /** Saved voice id, or null for "engine default for this language". */
  value: string | null;
  language: string;
  onChange: (voice: string | null) => void;
  /** Initial state of the internal "Show all voices" toggle. */
  showAll?: boolean;
  /** Replaces the built-in sample playback (the full player previews from the current segment). */
  onPreview?: (voice: string) => void;
}

/** Screen 8 / Screen 4 voice dropdown: voices for the language (plus
 * any-language voices), a Preview button for the selected voice, and a
 * "No longer available" note when the saved voice left the engine. */
export function VoicePicker({
  value,
  language,
  onChange,
  showAll: showAllInitially = false,
  onPreview,
}: VoicePickerProps) {
  const { data, isPending } = useVoices();
  const [showAll, setShowAll] = useState(showAllInitially);
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
  const options = showAll ? voices : [...(groups[base] ?? []), ...(groups.any ?? [])];
  const saved = value ? voices.find((voice) => voice.id === value) : undefined;
  const unavailable = !isPending && Boolean(value) && (!saved || !saved.available);

  async function preview() {
    if (!value || unavailable) return;
    setPreviewFailed(false);
    if (onPreview) {
      onPreview(value);
      return;
    }
    try {
      const url = await previewVoice(value);
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
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="min-h-11 max-w-full rounded-card border border-line bg-card px-3 text-sm"
      >
        <option value="">Default</option>
        {options.map((voice) => (
          <option key={voice.id} value={voice.id} disabled={!voice.available}>
            {voice.id}
            {voice.description ? ` — ${voice.description}` : ""}
            {voice.available ? "" : " (No longer available)"}
          </option>
        ))}
        {value && !options.some((voice) => voice.id === value) && (
          <option value={value} disabled>
            {value}
            {unavailable ? " (No longer available)" : ""}
          </option>
        )}
      </select>
      <button
        type="button"
        onClick={preview}
        disabled={!value || unavailable}
        className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
      >
        <Volume2 size={18} strokeWidth={1.75} aria-hidden />
        Preview
      </button>
      <label className="inline-flex min-h-11 items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={showAll}
          onChange={(event) => setShowAll(event.target.checked)}
          className="h-4 w-4"
        />
        Show all voices
      </label>
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
