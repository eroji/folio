import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRefreshVoices } from "../api/voices";
import { VoicePicker } from "../components/VoicePicker";
import { useTheme, type ThemeChoice } from "../hooks/useTheme";

const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"] as const;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5] as const;
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
] as const;

const voiceKey = (language: string) => `folio-voice-${language}`;

/** Screen 8. Theme and speed persist locally; the progress/settings API that
 * syncs them across devices is M5. */
export function SettingsPage() {
  const { choice, select } = useTheme();
  const refresh = useRefreshVoices();
  const [speed, setSpeed] = useState(() => localStorage.getItem("folio-speed") ?? "1");
  const [voices, setVoices] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(LANGUAGES.map(({ code }) => [code, localStorage.getItem(voiceKey(code))])),
  );

  const { mutate } = refresh;
  useEffect(() => {
    void mutate(); // Settings re-queries the engine when opened (spec "Discovery").
  }, [mutate]);

  function changeSpeed(value: string) {
    setSpeed(value);
    localStorage.setItem("folio-speed", value);
  }

  function changeVoice(language: string, voice: string | null) {
    setVoices((prev) => ({ ...prev, [language]: voice }));
    if (voice) localStorage.setItem(voiceKey(language), voice);
    else localStorage.removeItem(voiceKey(language));
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8">
      <h1 className="font-display text-2xl font-semibold">Settings</h1>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-display text-lg font-semibold">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEME_CHOICES.map((option) => (
            <label
              key={option}
              className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-medium capitalize has-[:checked]:border-brand-blue has-[:checked]:text-brand-blue"
            >
              <input
                type="radio"
                name="theme"
                value={option}
                checked={choice === option}
                onChange={() => select(option)}
                className="h-4 w-4"
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="default-speed" className="font-display text-lg font-semibold">
          Default playback speed
        </label>
        <select
          id="default-speed"
          value={speed}
          onChange={(event) => changeSpeed(event.target.value)}
          className="min-h-11 rounded-card border border-line bg-card px-3 text-sm"
        >
          {SPEEDS.map((value) => (
            <option key={value} value={String(value)}>
              {value}×
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Voices</h2>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-card px-4 text-sm font-medium disabled:opacity-50"
          >
            <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
            Refresh voices
          </button>
        </div>
        {LANGUAGES.map(({ code, label }) => (
          <div key={code} className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {label} <span className="text-muted">({code})</span>
            </p>
            <VoicePicker
              value={voices[code] ?? null}
              language={code}
              onChange={(voice) => changeVoice(code, voice)}
            />
          </div>
        ))}
      </div>

      <p className="text-sm text-muted">Listening settings sync across devices in M5.</p>
    </div>
  );
}
