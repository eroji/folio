/** Admin → Voices (HANDOFF §Admin · Voices): flat Settings-style rows on the
 * page background, grouped by language — languages that have books first
 * (most books), then other languages alphabetically, then Unassigned, then
 * No longer on the server. Names and narration instructions save on blur/Enter,
 * defaults on click, language assignment moves the row at once; there is no
 * Save button. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  useDeleteVoice,
  useRefreshVoices,
  useSetVoiceDefault,
  useUpdateVoice,
  useVoices,
  voiceLanguage,
  voiceOnServer,
  type Voice,
} from "../api/voices";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { PillSelect } from "../components/PillSelect";
import { VoicePreview } from "../components/VoicePreview";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
] as const;

function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code.charAt(0).toUpperCase() + code.slice(1);
}

const refreshPill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const pillButton =
  "tap inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const smallPill =
  "tap inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 text-sm font-semibold text-fg hover:bg-raised disabled:opacity-50";
const nameInput =
  "tap h-10 w-[200px] max-w-full rounded-full border border-border bg-raised px-[18px] text-base text-fg placeholder:text-fg-2";
const instructionsInput =
  "tap mb-4 w-full resize-y rounded-[18px] border border-border bg-raised px-[18px] py-2.5 text-base leading-[1.55] text-fg placeholder:text-fg-2";

/** "2 min ago" style age of the last voice fetch. */
function timeAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} days ago`;
}

const countVoices = (n: number): string => `${n} ${n === 1 ? "voice" : "voices"}`;
const countBooks = (n: number): string => `${n} ${n === 1 ? "book" : "books"}`;

interface VoiceGroup {
  key: string;
  code: string | null;
  label: string;
  voices: Voice[];
  /** Right-side text override on the heading (Unassigned note). */
  note?: string;
}

function buildGroups(items: Voice[]): VoiceGroup[] {
  const byLang = new Map<string, Voice[]>();
  const unassigned: Voice[] = [];
  for (const voice of items.filter(voiceOnServer)) {
    const code = voiceLanguage(voice);
    if (!code) unassigned.push(voice);
    else (byLang.get(code) ?? byLang.set(code, []).get(code)!).push(voice);
  }
  const booksOf = (voices: Voice[]): number => voices.reduce((sum, voice) => sum + (voice.books_count ?? 0), 0);
  const langs = [...byLang.entries()].map(([code, voices]) => ({ code, voices, books: booksOf(voices) }));
  langs.sort(
    (a, b) =>
      Number(b.books > 0) - Number(a.books > 0) ||
      b.books - a.books ||
      languageLabel(a.code).localeCompare(languageLabel(b.code)),
  );
  const groups: VoiceGroup[] = langs.map(({ code, voices }) => ({
    key: code,
    code,
    label: languageLabel(code),
    voices,
  }));
  if (unassigned.length > 0) {
    groups.push({
      key: "unassigned",
      code: null,
      label: "Unassigned",
      voices: unassigned,
      note: `Language couldn’t be detected · ${countVoices(unassigned.length)}`,
    });
  }
  const gone = items.filter((voice) => !voiceOnServer(voice));
  if (gone.length > 0) {
    groups.push({ key: "gone", code: null, label: "No longer on the server", voices: gone });
  }
  return groups;
}

/** One voice row. Normal language groups get name + Preview + default
 * radio; Unassigned gets Preview + an "Assign language…" select; voices
 * the server dropped get a warning line + Remove instead of Preview/Default. */
function VoiceRow({ voice, code, isDefault }: { voice: Voice; code: string | null; isDefault: boolean }) {
  const update = useUpdateVoice();
  const setDefault = useSetVoiceDefault();
  const remove = useDeleteVoice();
  const [name, setName] = useState(voice.display_name ?? "");
  useEffect(() => setName(voice.display_name ?? ""), [voice.display_name]);
  const [instructions, setInstructions] = useState(voice.instructions ?? "");
  useEffect(() => setInstructions(voice.instructions ?? ""), [voice.instructions]);

  const gone = !voiceOnServer(voice);
  const unassigned = !gone && code === null;
  const books = voice.books_count ?? 0;
  const failed = update.isError ? update.error : setDefault.isError ? setDefault.error : remove.isError ? remove.error : null;

  function commitName(): void {
    const next = name.trim();
    if (next !== (voice.display_name ?? "").trim()) update.mutate({ id: voice.id, display_name: next });
  }

  function commitInstructions(): void {
    const next = instructions.trim();
    if (next === (voice.instructions ?? "").trim()) return;
    update.mutate({ id: voice.id, instructions: next }, { onError: () => setInstructions(voice.instructions ?? "") });
  }

  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <span className="font-mono text-[15px] font-semibold">{voice.id}</span>
          <span className="text-base leading-snug text-fg-2">
            {gone ? (
              <span className="inline-flex items-center gap-1.5 text-warning">
                <Icon name="TriangleAlert" size={16} />
                Not on the TTS server · {countBooks(books)} fall{books === 1 ? "s" : ""} back to its language default
              </span>
            ) : unassigned ? (
              "Assign a language to name it and offer it to listeners"
            ) : (
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {books > 0 ? `Used by ${countBooks(books)}` : "Not used yet"}
                {voice.language_overridden && (
                  <button
                    type="button"
                    aria-label={`Unassign ${voice.id}`}
                    disabled={update.isPending}
                    onClick={() => update.mutate({ id: voice.id, language_override: null })}
                    className={smallPill}
                  >
                    <Icon name="RotateCcw" size={14} />
                    Unassign
                  </button>
                )}
              </span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!unassigned && (
            <input
              type="text"
              maxLength={40}
              placeholder="Display name"
              aria-label={`Display name for ${voice.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitName();
                }
              }}
              className={nameInput}
            />
          )}
          {!gone && <VoicePreview voice={voice.id} />}
          {gone ? (
            <button
              type="button"
              aria-label={`Remove ${voice.id}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(voice.id)}
              className={pillButton}
            >
              <Icon name="Trash2" size={18} />
              Remove
            </button>
          ) : unassigned ? (
            <PillSelect
              ariaLabel={`Language for ${voice.id}`}
              width="w-[190px]"
              value=""
              onChange={(next) => {
                if (next) update.mutate({ id: voice.id, language_override: next });
              }}
            >
              <option value="">Assign language…</option>
              {LANGUAGES.map(({ code: value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </PillSelect>
          ) : (
            <button
              type="button"
              role="radio"
              aria-checked={isDefault}
              aria-label={isDefault ? `Default ${languageLabel(code!)} voice` : `Make ${voice.id} the default ${languageLabel(code!)} voice`}
              disabled={isDefault || setDefault.isPending}
              onClick={() => setDefault.mutate({ language: code!, voiceId: voice.id })}
              className={clsx(
                "tap inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-base",
                isDefault
                  ? "bg-accent px-3.5 font-bold text-on-fg"
                  : "border border-border px-4 font-semibold text-fg hover:bg-raised",
              )}
            >
              {isDefault ? (
                <>
                  <Icon name="Check" size={18} />
                  Default
                </>
              ) : (
                "Set default"
              )}
            </button>
          )}
        </div>
      </div>
      {!gone && (
        <textarea
          aria-label={`Narration instructions for ${voice.id}`}
          rows={2}
          maxLength={500}
          placeholder="Warm, expressive, speak with a brisk pace."
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={commitInstructions}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitInstructions();
            }
          }}
          className={instructionsInput}
        />
      )}
      {failed && (
        <p role="alert" className="pb-3 text-sm text-danger">
          Couldn’t save — {failed.message}
        </p>
      )}
    </div>
  );
}

function GroupBlock({ group, defaults }: { group: VoiceGroup; defaults: Record<string, string> }) {
  const heading = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 pb-2 pt-6">
        <h3 className="font-display text-[18px]">
          {group.label}
          {group.code && <span className="ml-2 font-ui text-sm font-medium tracking-normal text-fg-2">{group.code}</span>}
        </h3>
        <span className="text-sm text-fg-2">{group.note ?? countVoices(group.voices.length)}</span>
      </div>
      {group.voices.map((voice) => (
        <VoiceRow key={voice.id} voice={voice} code={group.code} isDefault={group.code !== null && defaults[group.code] === voice.id} />
      ))}
    </>
  );
  return group.code === null ? (
    <div>{heading}</div>
  ) : (
    <div role="radiogroup" aria-label={`${group.label} voices`}>
      {heading}
    </div>
  );
}

export function AdminVoices() {
  const refresh = useRefreshVoices();
  const { data, dataUpdatedAt } = useVoices();
  const items = (data?.items ?? []).filter((voice) => voice.id !== "tts");
  const groups = buildGroups(items);
  const onServer = items.filter(voiceOnServer).length;
  const defaults: Record<string, string> = {};
  for (const voice of items) {
    const code = voiceLanguage(voice);
    if (voice.is_default && code) defaults[code] = voice.id;
  }
  Object.assign(defaults, data?.defaults ?? {});

  return (
    <section id="voices" aria-labelledby="voices-h" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <h2 id="voices-h" className="font-display text-xl">
          Voices
        </h2>
        <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} className={refreshPill}>
          <Icon name="RefreshCw" size={18} />
          Refresh voices
        </button>
      </div>
      <div className="flex flex-col gap-2 text-base leading-normal text-fg-2">
        <p>
          Friendly names for the voices on your TTS server, grouped by language. The default is used for books in that
          language unless a listener or a book picks another voice.
        </p>
        <p>
          Each voice’s language is detected automatically, from the language the TTS server reports or from the end of
          the voice ID: <span className="font-mono text-fg">-en</span> English, <span className="font-mono text-fg">-ja</span>{" "}
          Japanese, <span className="font-mono text-fg">-ko</span> or <span className="font-mono text-fg">-kr</span>{" "}
          Korean, <span className="font-mono text-fg">-zh</span> Chinese. Voices whose language can’t be detected go to{" "}
          <span className="font-semibold text-fg">Unassigned</span> until you pick one; listeners don’t see them until
          then.
        </p>
        {data && <p>{countVoices(onServer)} on the server, checked {timeAgo(Date.now() - dataUpdatedAt)}.</p>}
      </div>
      {refresh.isError && (
        <p role="alert" className="pt-2 text-sm text-danger">
          Couldn’t refresh the voices — {refresh.error.message}
        </p>
      )}
      {!data && (
        <div className="animate-pulse space-y-2 pt-6" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-md bg-raised" />
          ))}
        </div>
      )}
      {data && items.length === 0 && (
        <EmptyState
          icon={<Icon name="Speech" size={24} />}
          title="No voices found"
          description="Discovered voices appear here once the TTS backend answers."
        />
      )}
      {groups.map((group) => (
        <GroupBlock key={group.key} group={group} defaults={defaults} />
      ))}
    </section>
  );
}
