/** Settings (Direction D §4, voices redesign): title, left section tabs
 * driven by the URL (/settings/playback, /settings/voices; /settings
 * redirects to playback), rows with dividers, steppers and switches. The
 * tabs are a roving-tabindex tablist of links; on phones they sit side by
 * side above the content. Every change saves immediately; a failed save
 * reverts the control and shows an inline error under its row. */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useListeningSettings, useUpdateSettings } from "../api/settings";
import {
  baseLanguage,
  groupVoicesByLanguage,
  previewVoice,
  useVoices,
  voiceLabel,
  voiceOnServer,
  type Voice,
} from "../api/voices";
import { Icon } from "../components/Icon";
import { Switch } from "../components/Switch";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5] as const;

const SKIP_MIN = 5;
const SKIP_MAX = 120;
const SKIP_STEP = 5;

const SECTIONS = [
  { id: "playback", label: "Playback" },
  { id: "voices", label: "Voices" },
] as const;

/** Row order for language rows; anything else follows alphabetically. */
const LANG_ORDER = ["en", "ja", "ko", "zh"];

function languageLabel(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code; // unknown tag: show it raw
  }
}

/** The voice pinned for a base language, folding legacy variant keys
 * ("zh-TW") saved before pins were keyed by base language. */
function pinnedVoice(voices: Record<string, string | null>, base: string): string | null {
  if (voices[base]) return voices[base];
  for (const [key, value] of Object.entries(voices)) {
    if (value && baseLanguage(key) === base) return value;
  }
  return null;
}

/** The voices map to save when one language changes: every key of that
 * base language is replaced by the single base-language entry. */
function withPinned(
  voices: Record<string, string | null>,
  base: string,
  value: string | null,
): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const [key, kept] of Object.entries(voices)) {
    if (baseLanguage(key) !== base) next[key] = kept;
  }
  next[base] = value;
  return next;
}

const selectPill =
  "select-pill tap h-10 border border-border bg-raised text-base text-fg";
const selectChevron = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";

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
function VoicePreview({ id, name }: { id: string; name: string }) {
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
      const url = await previewVoice(id);
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
      aria-label={`Preview ${name}`}
      title={`Preview ${name}`}
      className="tap grid size-10 shrink-0 place-items-center rounded-full border border-border bg-transparent text-fg hover:bg-raised"
    >
      <Icon name={playing ? "Pause" : "Play"} size={18} />
    </button>
  );
}

/** One language row: "English en", 220 px pill select (Server default
 * first, then the language's voices by display name) + Preview. A pinned
 * voice the server no longer lists reads "(no longer available)" until the
 * row changes; playback then falls back to the server default. */
function VoiceRow({
  code,
  label,
  value,
  options,
  serverDefault,
  serverDefaultName,
  error,
  onChange,
}: {
  code: string;
  label: string;
  value: string | null;
  options: Voice[];
  serverDefault: string | null | undefined;
  serverDefaultName: string | null;
  error: boolean;
  onChange: (voice: string | null) => void;
}) {
  const listed = options.some((voice) => voice.id === value);
  const pinned = value && !listed ? value : null;
  const previewId = value ?? serverDefault ?? "";
  const preview = options.find((voice) => voice.id === previewId);
  const previewName = preview
    ? voiceLabel(preview)
    : voiceLabel({ id: previewId, language: code, description: null, available: true });

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
          width="w-[220px]"
          value={value ?? ""}
          onChange={(next) => onChange(next === "" ? null : next)}
        >
          <option value="">Server default{serverDefaultName ? ` (${serverDefaultName})` : ""}</option>
          {pinned && (
            <option value={pinned}>
              {voiceLabel({ id: pinned, language: code, description: null, available: false })}{" "}
              (no longer available)
            </option>
          )}
          {[...options]
            .sort((a, b) => voiceLabel(a).localeCompare(voiceLabel(b)))
            .map((voice) => (
              <option key={voice.id} value={voice.id} disabled={!voiceOnServer(voice)}>
                {voiceLabel(voice)}
                {voiceOnServer(voice) ? "" : " (no longer available)"}
              </option>
            ))}
        </PillSelect>
        {previewId && <VoicePreview id={previewId} name={previewName} />}
      </div>
    </Row>
  );
}

export function SettingsPage() {
  const { settings, isPending } = useListeningSettings();
  const { update, status } = useUpdateSettings();
  const { data: voices } = useVoices();
  const params = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const tabRefs = useRef(new Map<string, HTMLButtonElement | HTMLAnchorElement>());
  const section: string = SECTIONS.some((item) => item.id === params.section)
    ? params.section!
    : "playback";

  /** roving-tabindex tablist: arrows / Home / End move selection, focus and URL. */
  function onTabKeyDown(event: ReactKeyboardEvent, index: number) {
    const last = SECTIONS.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    const id = SECTIONS[next]!.id;
    navigate(`/settings/${id}`);
    tabRefs.current.get(id)?.focus();
  }

  /** The row a failed save is attributed to; the coalesced PUT covers every
   * key changed since the last success, so the error shows under the last one. */
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const saveFailed = status === "error";
  const change = (key: string, patch: Parameters<typeof update>[0]) => {
    setErrorKey(key);
    update(patch);
  };

  // The engine's "tts" entry is its internal fallback, not a real voice.
  const items = (voices?.items ?? []).filter((voice) => voice.id !== "tts");
  const groups = groupVoicesByLanguage(items);
  // Only languages with at least one voice get a row; zh-CN/zh-TW/… fold
  // into the single "zh" group by baseLanguage.
  const languages = Object.keys(groups)
    .filter((code) => code !== "any")
    .sort((a, b) => {
      const rank = (code: string) => {
        const index = LANG_ORDER.indexOf(code);
        return index < 0 ? LANG_ORDER.length : index;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });

  return (
    <div className="flex flex-col gap-8 pt-6">
      <h1 className="font-display text-3xl">Profile</h1>
      <div className="flex flex-wrap items-start gap-8 lg:gap-12">
        <div
          role="tablist"
          aria-label="Profile sections"
          className="flex w-full flex-row gap-1 lg:w-52 lg:flex-col"
        >
          {SECTIONS.map(({ id, label }, index) => (
            <Link
              key={id}
              ref={(node) => {
                if (node) tabRefs.current.set(id, node);
                else tabRefs.current.delete(id);
              }}
              to={`/settings/${id}`}
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={section === id}
              aria-controls="settings-panel"
              tabIndex={section === id ? 0 : -1}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={clsx(
                "tap flex h-11 flex-1 items-center justify-center rounded-full px-4 text-md lg:flex-none lg:justify-start",
                section === id ? "bg-raised font-bold text-fg" : "font-medium text-fg-2 hover:bg-raised",
              )}
            >
              {label}
            </Link>
          ))}
        </div>

        <div
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={-1}
          className="flex w-full min-w-0 flex-1 flex-col gap-10 lg:max-w-[760px]"
        >
          {section === "voices" ? (
            <section id="voices" aria-labelledby="voices-h" className="flex flex-col">
              <h2 id="voices-h" className="pb-2 font-display text-xl">
                Voices
              </h2>
              <p className="pb-2 text-base text-fg-2">
                Your narrator for each language. You can still pick a different narrator for any
                book from its ⋮ menu.
              </p>
              {isPending || !voices ? (
                <div className="h-40 animate-pulse rounded-xl bg-surface" aria-busy="true" />
              ) : languages.length === 0 ? (
                <p className="py-4 text-base text-fg-2">No voices on this server.</p>
              ) : (
                <div>
                  {languages.map((code) => {
                    const serverDefault = voices.defaults?.[code];
                    const serverDefaultVoice = serverDefault
                      ? items.find((voice) => voice.id === serverDefault)
                      : undefined;
                    return (
                      <VoiceRow
                        key={code}
                        code={code}
                        label={languageLabel(code)}
                        value={pinnedVoice(settings.voices, code)}
                        options={groups[code] ?? []}
                        serverDefault={serverDefault}
                        serverDefaultName={serverDefaultVoice ? voiceLabel(serverDefaultVoice) : null}
                        error={saveFailed && errorKey === `voice-${code}`}
                        onChange={(voice) =>
                          change(`voice-${code}`, { voices: withPinned(settings.voices, code, voice) })
                        }
                      />
                    );
                  })}
                </div>
              )}
            </section>
          ) : isPending ? (
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
        </div>
      </div>
    </div>
  );
}
