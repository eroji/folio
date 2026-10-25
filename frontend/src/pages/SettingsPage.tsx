import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useListeningSettings, useUpdateSettings } from "../api/settings";
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

const SKIP_MIN = 5;
const SKIP_MAX = 120;
const inputClass = "min-h-11 rounded-card border border-line bg-card px-3 text-sm";
const toggleRow = "flex min-h-11 items-center justify-between gap-3";

function skipValid(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= SKIP_MIN && n <= SKIP_MAX;
}

/** Number input for a skip interval: local text so the user can type freely,
 * inline validation, and a commit only while the value is in range. */
function SkipField({
  id,
  label,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  onCommit: (seconds: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const invalid = text.trim() !== "" && !skipValid(text);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={SKIP_MIN}
          max={SKIP_MAX}
          value={text}
          aria-invalid={invalid}
          onChange={(event) => {
            setText(event.target.value);
            if (skipValid(event.target.value)) onCommit(Number(event.target.value));
          }}
          className={`${inputClass} w-24`}
        />
        <span className="text-sm text-muted">seconds ({SKIP_MIN}–{SKIP_MAX})</span>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-danger">
          Enter a whole number from {SKIP_MIN} to {SKIP_MAX} seconds.
        </p>
      )}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className={toggleRow}>
      <span className="font-medium">{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5"
      />
    </label>
  );
}

/** Screen 8. Listening settings sync across devices (M5); theme stays local. */
export function SettingsPage() {
  const { choice, select } = useTheme();
  const refresh = useRefreshVoices();
  const { settings, isPending } = useListeningSettings();
  const { update, status } = useUpdateSettings();

  const { mutate } = refresh;
  useEffect(() => {
    void mutate(); // Settings re-queries the engine when opened (spec "Discovery").
  }, [mutate]);

  const saveLabel =
    status === "saving"
      ? "Saving…"
      : status === "saved"
        ? "Saved"
        : status === "error"
          ? "Couldn’t save — using this device’s settings."
          : null;

  function changeVoice(language: string, voice: string | null) {
    const voices = { ...settings.voices };
    if (voice) voices[language] = voice;
    else delete voices[language];
    update({ voices });
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        {saveLabel && (
          <span role="status" className="text-sm text-muted">
            {saveLabel}
          </span>
        )}
      </div>

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

      {isPending ? (
        <div className="flex animate-pulse flex-col gap-4" aria-busy="true">
          <div className="h-11 rounded-card bg-card" />
          <div className="h-11 w-24 rounded-card bg-card" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="default-speed" className="font-display text-lg font-semibold">
              Default playback speed
            </label>
            <select
              id="default-speed"
              value={String(settings.speed)}
              onChange={(event) => update({ speed: Number(event.target.value) })}
              className={`${inputClass} max-w-40`}
            >
              {SPEEDS.map((value) => (
                <option key={value} value={String(value)}>
                  {value}×
                </option>
              ))}
            </select>
          </div>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 font-display text-lg font-semibold">Skip intervals</legend>
            <SkipField
              id="skip-back"
              label="Back"
              value={settings.skip_back}
              onCommit={(seconds) => update({ skip_back: seconds })}
            />
            <SkipField
              id="skip-forward"
              label="Forward"
              value={settings.skip_forward}
              onCommit={(seconds) => update({ skip_forward: seconds })}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-display text-lg font-semibold">Playback</legend>
            <Toggle
              id="auto-next"
              label="Auto-play next chapter"
              checked={settings.auto_next}
              onChange={(next) => update({ auto_next: next })}
            />
            <Toggle
              id="speak-titles"
              label="Speak chapter titles"
              checked={settings.speak_titles}
              onChange={(next) => update({ speak_titles: next })}
            />
          </fieldset>
        </>
      )}

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
              value={settings.voices[code] ?? null}
              language={code}
              onChange={(voice) => changeVoice(code, voice)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
