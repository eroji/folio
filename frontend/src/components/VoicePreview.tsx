/** 40 px outlined round button speaking a sample of one voice (Play → Pause).
 * Shared by Settings → Voices and Admin → Voices. With `label` it renders as
 * an outlined pill with text instead (the admin instructions editor), and
 * `instructions` previews an unsaved draft rather than the saved text. */
import { useEffect, useRef, useState } from "react";
import { previewVoice } from "../api/voices";
import { Icon } from "./Icon";

export function VoicePreview({
  voice,
  instructions,
  label,
}: {
  voice: string;
  instructions?: string;
  label?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const sample = useRef<{ url: string; audio: HTMLAudioElement } | null>(null);

  function stop() {
    if (sample.current) {
      sample.current.audio.pause();
      URL.revokeObjectURL(sample.current.url);
      sample.current = null;
    }
    setPlaying(false);
  }
  useEffect(() => stop, []);

  async function toggle() {
    if (playing) {
      stop();
      return;
    }
    try {
      const url = await previewVoice(voice, instructions);
      const audio = new Audio(url);
      sample.current = { url, audio };
      setPlaying(true);
      audio.addEventListener("ended", () => {
        if (sample.current?.audio === audio) stop();
      });
      audio.play().catch(stop);
    } catch {
      stop();
    }
  }

  if (label) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised"
      >
        <Icon name={playing ? "Pause" : "Play"} size={18} />
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Preview ${voice}`}
      title={`Preview ${voice}`}
      className="tap grid size-10 shrink-0 place-items-center rounded-full border border-border bg-transparent text-fg hover:bg-raised"
    >
      <Icon name={playing ? "Pause" : "Play"} size={18} />
    </button>
  );
}
