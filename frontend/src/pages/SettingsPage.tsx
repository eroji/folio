/** Settings (Direction D §4): title, left section pills (Playback and
 * Voices only — the app is dark, there is no Theme), rows with dividers,
 * steppers and switches. Every change saves immediately; a failed save
 * reverts the control and shows an inline error under its row. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
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

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese, Simplified" },
  { code: "zh-TW", label: "Chinese, Traditional" },
] as const;

const SKIP_MIN = 5;
const SKIP_MAX = 120;
const SKIP_STEP = 5;

const SECTIONS = [
  { id: "playback", label: "Playback" },
  { id: "voices", label: "Voices" },
] as const;

const selectPill =
  "select-pill tap h-10 border border-border bg-raised text-base text-fg";
const selectChevron = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";
const outlinedPill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";

function skipValid(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= SKIP_MIN && n <= SKIP_MAX;
}

function PillSelect({
  ariaLabel,
  width,
  value,
  disabled,
  onChange,
  children,
}: {
  ariaLabel: string;
  width: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className={clsx("relative inline-flex", width, "max-w-full")}>
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(selectPill, "w-full")}
      >
        {children}
      </select>
      <Icon name="ChevronDown" size={18} className={selectChevron} />
    </span>
  );
}

/** One setting row: bold title + one-line explanation left, control right,
 * divider above; optional inline error under (failed save). */
function Row({
  title,
  description,
  error,
  children,
}: {
  title: ReactNode;
  description?: string;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <span className="text-lg font-bold">{title}</span>
          {description && <span className="text-base leading-snug text-fg-2">{description}</span>}
        </div>
        {children}
      </div>
      {error}
    </div>
  );
}

function SaveError() {
  return (
    <p role="alert" className="pb-3 text-sm text-danger">
      Couldn’t save — the change reverted to the saved settings.
    </p>
  );
}

/** − value + stepper (5–120 s, step 5). Typing validates like the old
 * field; the arrows commit immediately. */
function SkipStepper({
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

  function step(delta: number) {
    const current = skipValid(text) ? Number(text) : value;
    const next = Math.min(SKIP_MAX, Math.max(SKIP_MIN, current + delta));
    setText(String(next));
    onCommit(next);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-raised p-[3px]">
          <button
            type="button"
            aria-label={`Less ${label}`}
            title={`Less ${label}`}
            onClick={() => step(-SKIP_STEP)}
            className="tap grid size-[34px] shrink-0 place-items-center rounded-full text-fg hover:bg-border/60"
          >
            <Icon name="ChevronLeft" size={18} />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={SKIP_MIN}
            max={SKIP_MAX}
            step={SKIP_STEP}
            aria-label={`${label} in seconds`}
            aria-invalid={invalid}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (skipValid(event.target.value)) onCommit(Number(event.target.value));
            }}
            className="tap h-[34px] w-11 border-0 bg-transparent text-center text-md font-bold tabular text-fg [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label={`More ${label}`}
            title={`More ${label}`}
            onClick={() => step(SKIP_STEP)}
            className="tap grid size-[34px] shrink-0 place-items-center rounded-full text-fg hover:bg-border/60"
          >
            <Icon name="ChevronRight" size={18} />
          </button>
        </span>
        <span aria-hidden className="text-base text-fg-2">
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

/** 40 px outlined pill button speaking a sample of one voice (Play → Pause). */
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
      title={`Preview ${voice}`}
      className="tap grid size-10 shrink-0 place-items-center rounded-full border border-border bg-transparent text-fg hover:bg-raised"
    >
      <Icon name={playing ? "Pause" : "Play"} size={18} />
    </button>
  );
}

/** One language row: "English en", 180 px voice pill select + Preview. A
 * saved voice the engine no longer lists reads "(no longer available)". */
function VoiceRow({
  code,
  label,
  value,
  options,
  error,
  onChange,
}: {
  code: string;
  label: string;
  value: string | undefined;
  options: Voice[];
  error: boolean;
  onChange: (voice: string) => void;
}) {
  const empty = options.length === 0;
  const listed = options.some((voice) => voice.id === value);
  const selected = value ?? options.find((voice) => voice.available)?.id ?? options[0]?.id ?? "";

  return (
    <Row
      title={
        <>
          {label} <span className="text-base font-medium text-fg-2">{code}</span>
        </>
      }
      error={error ? <SaveError /> : undefined}
    >
      <div className="flex items-center gap-2">
        <PillSelect
          ariaLabel={`Voice for ${label}`}
          width="w-[180px]"
          value={selected}
          disabled={empty}
          onChange={onChange}
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
        </PillSelect>
        {!empty && selected && <VoicePreview voice={selected} />}
      </div>
    </Row>
  );
}

export function SettingsPage() {
  const refresh = useRefreshVoices();
  const { settings, isPending } = useListeningSettings();
  const { update, status } = useUpdateSettings();
  const { data: voices } = useVoices();
  const { mutate } = refresh;
  const [section, setSection] = useState<string>("playback");
  /** The row a failed save is attributed to; the coalesced PUT covers every
   * key changed since the last success, so the error shows under the last one. */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    void mutate(); // Settings re-queries the engine when opened (spec "Discovery").
  }, [mutate]);

  const saveFailed = status === "error";
  const change = (key: string, patch: Parameters<typeof update>[0]) => {
    setErrorKey(key);
    update(patch);
  };

  // The engine's "tts" entry is its internal fallback, not a real voice.
  const items = (voices?.items ?? []).filter((voice) => voice.id !== "tts");
  const availableCount = items.filter((voice) => voice.available).length;
  const groups = groupVoicesByLanguage(items);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-display text-4xl">Settings</h1>
      <div className="flex flex-wrap items-start gap-8 desktop:gap-12">
        <nav aria-label="Settings sections" className="flex w-full flex-col gap-1 desktop:w-52">
          {SECTIONS.map(({ id, label }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={section === id ? "true" : undefined}
              onClick={() => setSection(id)}
              className={clsx(
                "tap flex h-11 items-center rounded-full px-4 text-md no-underline",
                section === id ? "bg-raised font-bold text-fg" : "font-medium text-fg-2 hover:bg-raised",
              )}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex w-full min-w-0 flex-1 flex-col gap-10 desktop:max-w-[760px]">
          {isPending ? (
            <div className="h-72 animate-pulse rounded-xl bg-surface" aria-busy="true" />
          ) : (
            <section id="playback" aria-labelledby="playback-h" className="flex flex-col">
              <h2 id="playback-h" className="pb-2 font-display text-xl">
                Playback
              </h2>
              <Row title="Default speed" description="Used when you start a new book" error={saveFailed && errorKey === "speed" ? <SaveError /> : undefined}>
                <PillSelect
                  ariaLabel="Default playback speed"
                  width="w-[120px]"
                  value={String(settings.speed)}
                  onChange={(value) => change("speed", { speed: Number(value) })}
                >
                  {(SPEEDS as readonly number[]).includes(settings.speed) ? (
                    SPEEDS.map((value) => (
                      <option key={value} value={String(value)}>
                        {value}×
                      </option>
                    ))
                  ) : (
                    <>
                      <option value={String(settings.speed)}>{settings.speed}×</option>
                      {SPEEDS.map((value) => (
                        <option key={value} value={String(value)}>
                          {value}×
                        </option>
                      ))}
                    </>
                  )}
                </PillSelect>
              </Row>
              <Row
                title="Skip back"
                description="Jump back this many seconds"
                error={saveFailed && errorKey === "skip_back" ? <SaveError /> : undefined}
              >
                <SkipStepper
                  label="Skip back"
                  value={settings.skip_back}
                  onCommit={(seconds) => change("skip_back", { skip_back: seconds })}
                />
              </Row>
              <Row
                title="Skip forward"
                description="Jump ahead this many seconds"
                error={saveFailed && errorKey === "skip_forward" ? <SaveError /> : undefined}
              >
                <SkipStepper
                  label="Skip forward"
                  value={settings.skip_forward}
                  onCommit={(seconds) => change("skip_forward", { skip_forward: seconds })}
                />
              </Row>
              <Row
                title="Auto-play next chapter"
                description="Keep going when a chapter ends"
                error={saveFailed && errorKey === "auto_next" ? <SaveError /> : undefined}
              >
                <Switch
                  label="Auto-play next chapter"
                  checked={settings.auto_next}
                  onChange={(next) => change("auto_next", { auto_next: next })}
                />
              </Row>
              <Row
                title="Speak chapter titles"
                description="Read each chapter’s title before its text"
                error={saveFailed && errorKey === "speak_titles" ? <SaveError /> : undefined}
              >
                <Switch
                  label="Speak chapter titles"
                  checked={settings.speak_titles}
                  onChange={(next) => change("speak_titles", { speak_titles: next })}
                />
              </Row>
            </section>
          )}

          <section id="voices" aria-labelledby="voices-h" className="flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
              <h2 id="voices-h" className="font-display text-xl">
                Voices
              </h2>
              <button
                type="button"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                className={outlinedPill}
              >
                <Icon name="RefreshCw" size={18} />
                Refresh voices
              </button>
            </div>
            <p className="pb-2 text-base text-fg-2">
              Your narrator for each book language. A book’s own narrator setting overrides these.
              {voices && (
                <>
                  {" "}
                  {availableCount} {availableCount === 1 ? "voice" : "voices"} from your TTS server.
                </>
              )}
            </p>
            {isPending || !voices ? (
              <div className="h-40 animate-pulse rounded-xl bg-surface" aria-busy="true" />
            ) : (
              <div>
                {LANGUAGES.map(({ code, label }) => (
                  <VoiceRow
                    key={code}
                    code={code}
                    label={label}
                    value={settings.voices[code]}
                    options={groups[code.split("-")[0]!.toLowerCase()] ?? []}
                    error={saveFailed && errorKey === `voice-${code}`}
                    onChange={(voice) =>
                      change(`voice-${code}`, { voices: { ...settings.voices, [code]: voice } })
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
