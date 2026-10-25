import { useEffect, useState } from "react";
import clsx from "clsx";
import { useListeningSettings, useUpdateSettings } from "../api/settings";
import { useRefreshVoices } from "../api/voices";
import { Icon } from "../components/Icon";
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
const inputClass = "tap h-9 rounded-md border border-control-border bg-surface px-3 text-base";
const toggleRow = "tap flex min-h-9 items-center justify-between gap-3";
const sectionTitle = "font-display text-lg font-semibold";

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
      <label htmlFor={id} className="text-base font-medium">
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
        <span className="text-sm text-fg-2">seconds ({SKIP_MIN}–{SKIP_MAX})</span>
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
      <span className="text-base font-medium">{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-5 accent-progress"
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

  function changeVoice(language: string, voice: string) {
    update({ voices: { ...settings.voices, [language]: voice } });
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-xl font-bold tracking-[-0.01em]">Settings</h1>
        {saveLabel && (
          <span role="status" className="text-sm text-fg-2">
            {saveLabel}
          </span>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={clsx(sectionTitle, "mb-2")}>Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEME_CHOICES.map((option) => (
            <label
              key={option}
              className="tap inline-flex h-9 items-center gap-2 rounded-md border border-control-border bg-surface px-3 text-base font-medium capitalize has-[:checked]:border-accent-fg has-[:checked]:bg-selected has-[:checked]:text-accent-fg"
            >
              <input
                type="radio"
                name="theme"
                value={option}
                checked={choice === option}
                onChange={() => select(option)}
                className="size-4 accent-progress"
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      {isPending ? (
        <div className="flex animate-pulse flex-col gap-4" aria-busy="true">
          <div className="h-9 rounded-md bg-raised" />
          <div className="h-9 w-24 rounded-md bg-raised" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="default-speed" className={sectionTitle}>
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
            <legend className={clsx(sectionTitle, "mb-2")}>Skip intervals</legend>
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
            <legend className={clsx(sectionTitle, "mb-1")}>Playback</legend>
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
          <h2 className={sectionTitle}>Voices</h2>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="tap inline-flex h-9 items-center gap-2 rounded-md border border-control-border bg-surface px-3 text-base font-medium hover:bg-raised disabled:opacity-50"
          >
            <Icon name="restart_alt" size={18} />
            Refresh voices
          </button>
        </div>
        {LANGUAGES.map(({ code, label }) => (
          <div key={code} className="flex flex-col gap-1">
            <p className="text-base font-medium">
              {label} <span className="text-fg-2">({code})</span>
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
