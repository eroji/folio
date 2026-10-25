import { useEffect, useRef, useState, type ReactNode } from "react";
import { useListeningSettings, useUpdateSettings } from "../api/settings";
import {
  groupVoicesByLanguage,
  previewVoice,
  useRefreshVoices,
  useVoices,
  voiceLabel,
  type Voice,
} from "../api/voices";
import { Icon } from "../components/Icon";
import { Switch } from "../components/Switch";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5] as const;
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese, Simplified" },
  { code: "zh-TW", label: "Chinese, Traditional" },
] as const;

const SKIP_MIN = 5;
const SKIP_MAX = 120;
const control = "h-9 rounded-md border border-control-border bg-surface text-base";

function skipValid(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= SKIP_MIN && n <= SKIP_MAX;
}

/** Card in the Manage-tab style: bordered surface, 8 px radius, header row
 * with the section title (15 px/700) and optional action, rows below. */
function Card({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-divider bg-surface px-4 pb-2">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 pt-3">
        <h2 id={id} className="text-md font-bold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One setting row: label (14 px/600) plus optional one-line description
 * (13 px secondary) on the left, the control right-aligned. */
function Row({ title, description, children }: { title: ReactNode; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
        <span className="text-base font-semibold">{title}</span>
        {description && <span className="text-sm text-fg-2">{description}</span>}
      </div>
      {children}
    </div>
  );
}

/** Number input for a skip interval: local text so the user can type freely,
 * inline validation, and a commit only while the value is in range. */
function SkipField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (seconds: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const invalid = text.trim() !== "" && !skipValid(text);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={SKIP_MIN}
          max={SKIP_MAX}
          step={5}
          aria-label={label}
          aria-invalid={invalid}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (skipValid(event.target.value)) onCommit(Number(event.target.value));
          }}
          className={`${control} tap w-[76px] px-2.5 text-right tabular-nums`}
        />
        <span aria-hidden className="w-7 text-sm text-fg-2">
          sec
        </span>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-danger">
          Enter a whole number from {SKIP_MIN} to {SKIP_MAX}.
        </p>
      )}
    </div>
  );
}

/** 36 px play/stop button speaking a sample of one voice. */
function VoicePreview({ voice }: { voice: string }) {
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
      const url = await previewVoice(voice);
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

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Preview ${voice}`}
      title="Preview voice"
      className="tap grid size-9 place-items-center rounded-md border border-control-border bg-surface text-fg"
    >
      <Icon name={playing ? "stop" : "play_arrow"} size={20} />
    </button>
  );
}

/** One language's row: a 168 px select (same width everywhere so the
 * column lines up) plus Preview. A saved voice the engine no longer lists
 * stays selected and reads "{voice} (no longer available)". */
function VoiceRow({
  code,
  label,
  value,
  options,
  onChange,
}: {
  code: string;
  label: string;
  value: string | undefined;
  options: Voice[];
  onChange: (voice: string) => void;
}) {
  const empty = options.length === 0;
  const listed = options.some((voice) => voice.id === value);
  const selected = value ?? options.find((voice) => voice.available)?.id ?? options[0]?.id ?? "";

  return (
    <Row
      title={
        <>
          {label} <span className="text-sm font-medium text-fg-2">{code}</span>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <select
          aria-label={`Voice for ${label}`}
          value={selected}
          onChange={(event) => onChange(event.target.value)}
          disabled={empty}
          className={`${control} tap w-[168px] max-w-full px-2`}
        >
          {empty ? (
            <option value="">No voices available for this language</option>
          ) : (
            <>
              {value && !listed && <option value={value}>{value} (no longer available)</option>}
              {options.map((voice) => (
                <option key={voice.id} value={voice.id} disabled={!voice.available}>
                  {voiceLabel(voice)}
                  {voice.available ? "" : " (no longer available)"}
                </option>
              ))}
            </>
          )}
        </select>
        {!empty && selected && <VoicePreview voice={selected} />}
      </div>
    </Row>
  );
}

/** Settings (handoff "Other designed screens"): cards of setting rows,
 * every control saving on change through the optimistic useUpdateSettings.
 * The app is dark only — there is no Appearance card. */
export function SettingsPage() {
  const refresh = useRefreshVoices();
  const { settings, isPending } = useListeningSettings();
  const { update, status } = useUpdateSettings();
  const { data: voices } = useVoices();
  const { mutate } = refresh;
  useEffect(() => {
    void mutate(); // Settings re-queries the engine when opened (spec "Discovery").
  }, [mutate]);

  // The engine's "tts" entry is its internal fallback, not a real voice.
  const items = (voices?.items ?? []).filter((voice) => voice.id !== "tts");
  const availableCount = items.filter((voice) => voice.available).length;
  const groups = groupVoicesByLanguage(items);

  function changeVoice(language: string, voice: string) {
    update({ voices: { ...settings.voices, [language]: voice } });
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
        <h1 className="font-display text-xl font-bold tracking-[-0.01em]">Settings</h1>
        <span role="status" className="inline-flex items-center gap-1 text-sm text-fg-2">
          <Icon name="check" size={16} /> Changes save automatically
        </span>
      </div>
      {status === "error" && (
        <p role="alert" className="-mt-2 text-sm text-danger">
          Couldn’t save — the change reverted to the saved settings.
        </p>
      )}

      {isPending ? (
        <div className="h-56 animate-pulse rounded-lg border border-divider bg-surface" aria-busy="true" />
      ) : (
        <Card id="s-playback" title="Playback">
          <div className="divide-y divide-divider">
            <Row title="Default speed" description="Used when you start a new book">
              <select
                aria-label="Default playback speed"
                value={String(settings.speed)}
                onChange={(event) => update({ speed: Number(event.target.value) })}
                className={`${control} tap w-[104px] px-2`}
              >
                {SPEEDS.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}×
                  </option>
                ))}
              </select>
            </Row>
            <Row title="Skip back" description={`${SKIP_MIN} to ${SKIP_MAX} seconds`}>
              <SkipField
                label="Skip back in seconds"
                value={settings.skip_back}
                onCommit={(seconds) => update({ skip_back: seconds })}
              />
            </Row>
            <Row title="Skip forward" description={`${SKIP_MIN} to ${SKIP_MAX} seconds`}>
              <SkipField
                label="Skip forward in seconds"
                value={settings.skip_forward}
                onCommit={(seconds) => update({ skip_forward: seconds })}
              />
            </Row>
            <Row title="Auto-play next chapter" description="Keep going when a chapter ends">
              <Switch
                label="Auto-play next chapter"
                checked={settings.auto_next}
                onChange={(next) => update({ auto_next: next })}
              />
            </Row>
            <Row title="Speak chapter titles" description="Read each chapter’s title before its text">
              <Switch
                label="Speak chapter titles"
                checked={settings.speak_titles}
                onChange={(next) => update({ speak_titles: next })}
              />
            </Row>
          </div>
        </Card>
      )}

      <Card
        id="s-voices"
        title="Voices"
        action={
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="tap inline-flex h-8 items-center gap-1.5 rounded-md border border-control-border bg-surface px-2.5 text-sm font-medium hover:bg-raised disabled:opacity-50"
          >
            <Icon name="refresh" size={18} /> Refresh voices
          </button>
        }
      >
        <p className="pb-1 text-sm text-fg-2">
          Your narrator for each book language. A book’s own narrator setting overrides these.
          {voices && (
            <> {availableCount} {availableCount === 1 ? "voice" : "voices"} available from the TTS server.</>
          )}
        </p>
        {isPending || !voices ? (
          <div className="h-40 animate-pulse rounded-md bg-raised" aria-busy="true" />
        ) : (
          <div className="border-t border-divider divide-y divide-divider">
            {LANGUAGES.map(({ code, label }) => (
              <VoiceRow
                key={code}
                code={code}
                label={label}
                value={settings.voices[code]}
                options={groups[code.split("-")[0]!.toLowerCase()] ?? []}
                onChange={(voice) => changeVoice(code, voice)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
