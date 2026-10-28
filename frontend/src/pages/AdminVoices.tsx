/** Admin → Voices (HANDOFF §Admin · Voices): flat Settings-style rows on the
 * page background, grouped by language — languages that have books first
 * (most books), then other languages alphabetically, then Unassigned, then
 * No longer on the server. Names save on blur/Enter, defaults on click,
 * language assignment moves the row at once. Speaking instructions stay
 * compact: one truncated italic line per row plus an "Instructions" pill that
 * expands an editor under that row only (one open at a time). */
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  useDeleteVoice,
  useRefreshVoices,
  useSetVoiceDefault,
  useUpdateVoice,
  useVoices,
  voiceLabel,
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
  "tap w-full resize-y rounded-[18px] border border-border bg-raised px-[18px] py-3 text-[15px] leading-[1.55] text-fg placeholder:text-fg-2";
const editorPill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const savePill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-fg px-[18px] text-base font-bold text-on-fg hover:opacity-90 disabled:opacity-50";

/** Max characters of per-voice speaking instructions (mirrors the backend). */
const INSTRUCTIONS_MAX = 1000;

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

/** The expanded instructions editor under one row. Mounts with the draft
 * initialised from the saved value; closing discards it. Save PATCHes the
 * draft (empty clears) and closes; a failure keeps it open and the row shows
 * the error. */
function InstructionsEditor({
  voice,
  update,
  onClose,
}: {
  voice: Voice;
  update: ReturnType<typeof useUpdateVoice>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(voice.instructions ?? "");
  return (
    <div className="flex flex-col gap-2.5 pb-4">
      <label htmlFor={`instructions-${voice.id}`} className="text-[13px] font-semibold">
        Speaking instructions for {voiceLabel(voice)}
      </label>
      <textarea
        id={`instructions-${voice.id}`}
        rows={4}
        maxLength={INSTRUCTIONS_MAX}
        placeholder="Warm, expressive, speak with a brisk pace."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className={instructionsInput}
      />
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="text-xs text-fg-2">
          Sent to the TTS server with every request for this voice · {draft.length} / {INSTRUCTIONS_MAX}
        </span>
        <div className="flex items-center gap-2">
          <VoicePreview voice={voice.id} instructions={draft} label="Preview" />
          <button type="button" onClick={onClose} className={editorPill}>
            Cancel
          </button>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: voice.id, instructions: draft.trim() }, { onSuccess: onClose })}
            className={savePill}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** One voice row. Normal language groups get name + Preview + Instructions
 * pill + default radio; Unassigned gets Preview + an "Assign language…"
 * select; voices the server dropped get a warning line + Remove instead of
 * Preview/Default. Only assigned, on-server rows show instructions. */
function VoiceRow({
  voice,
  code,
  isDefault,
  open,
  onOpenChange,
}: {
  voice: Voice;
  code: string | null;
  isDefault: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateVoice();
  const setDefault = useSetVoiceDefault();
  const remove = useDeleteVoice();
  const [name, setName] = useState(voice.display_name ?? "");
  useEffect(() => setName(voice.display_name ?? ""), [voice.display_name]);

  const gone = !voiceOnServer(voice);
  const unassigned = !gone && code === null;
  const books = voice.books_count ?? 0;
  const failed = update.isError ? update.error : setDefault.isError ? setDefault.error : remove.isError ? remove.error : null;

  function commitName(): void {
    const next = name.trim();
    if (next !== (voice.display_name ?? "").trim()) update.mutate({ id: voice.id, display_name: next });
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
              <span className="flex min-w-0 flex-col gap-0.5">
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
                <span className="flex min-w-0 items-center gap-2">
                  <Icon name="AlignLeft" size={14} />
                  {voice.instructions ? (
                    <span className="min-w-0 truncate italic">{voice.instructions}</span>
                  ) : (
                    "No speaking instructions"
                  )}
                </span>
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
          {!gone && <VoicePreview voice={voice.id} instructions={voice.instructions} />}
          {!gone && !unassigned && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Speaking instructions for ${voice.id}`}
              title="Speaking instructions"
              onClick={() => onOpenChange(!open)}
              className={clsx(
                "tap inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-base font-semibold text-fg hover:bg-raised",
                open ? "border-fg bg-raised" : "border-border",
              )}
            >
              <Icon name="Pencil" size={16} />
              Instructions
            </button>
          )}
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
      {open && !gone && <InstructionsEditor voice={voice} update={update} onClose={() => onOpenChange(false)} />}
      {failed && (
        <p role="alert" className="pb-3 text-sm text-danger">
          Couldn’t save — {failed.message}
        </p>
      )}
    </div>
  );
}

function GroupBlock({
  group,
  defaults,
  openId,
  setOpenId,
}: {
  group: VoiceGroup;
  defaults: Record<string, string>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
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
        <VoiceRow
          key={voice.id}
          voice={voice}
          code={group.code}
          isDefault={group.code !== null && defaults[group.code] === voice.id}
          open={openId === voice.id}
          onOpenChange={(next) => setOpenId(next ? voice.id : null)}
        />
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
  const [openId, setOpenId] = useState<string | null>(null);
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
        <GroupBlock key={group.key} group={group} defaults={defaults} openId={openId} setOpenId={setOpenId} />
      ))}
    </section>
  );
}
