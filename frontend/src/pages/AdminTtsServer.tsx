/** Admin → Voices → TTS server: the OpenAI-compatible speech server, its key,
 * how many requests go to it at once, and whether a segment is sent whole or
 * one sentence per request. Each falls back to the server's environment
 * (TTS_BASE_URL, TTS_CONCURRENCY, TTS_REQUEST_CHARS) while unset here. Test
 * runs on the form as typed, before saving (an empty key field uses the saved
 * key). */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  testTtsServer,
  useIntegrations,
  useSaveIntegrations,
  type TtsServer,
  type TtsServerDraft,
  type TtsTestResult,
} from "../api/integrations";
import {
  TestResultLine,
  adminHint as hint,
  adminInput as input,
  adminLabel as fieldLabel,
  adminOutlinePill as outlinePill,
  adminSavePill as savePill,
  useTest,
} from "../components/TestResult";

const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 16;

interface Form {
  base_url: string;
  api_key: string;
  concurrency: string;
  /** null: the server's TTS_REQUEST_CHARS decides. */
  sentence_requests: boolean | null;
}

function fromSaved(tts: TtsServer): Form {
  return {
    base_url: tts.base_url,
    api_key: "",
    concurrency: tts.concurrency === null ? "" : String(tts.concurrency),
    sentence_requests: tts.sentence_requests,
  };
}

/** The typed concurrency: null when empty, NaN when not a whole number in range. */
function parseConcurrency(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= CONCURRENCY_MIN && n <= CONCURRENCY_MAX ? n : Number.NaN;
}

function Settings({ tts }: { tts: TtsServer }) {
  const save = useSaveIntegrations();
  const queryClient = useQueryClient();
  const connection = useTest<TtsTestResult>();
  const [form, setForm] = useState<Form>(() => fromSaved(tts));
  // A save (or another admin's) moves the form to the saved values; a typed key stays.
  useEffect(() => {
    setForm((current) => ({
      ...current,
      base_url: tts.base_url,
      concurrency: tts.concurrency === null ? "" : String(tts.concurrency),
      sentence_requests: tts.sentence_requests,
    }));
  }, [tts.base_url, tts.concurrency, tts.sentence_requests]);

  const concurrency = parseConcurrency(form.concurrency);
  const concurrencyBad = Number.isNaN(concurrency);
  const sentences = form.sentence_requests ?? tts.env_request_chars > 0;
  const dirty =
    form.base_url.trim() !== tts.base_url ||
    form.api_key.trim() !== "" ||
    concurrency !== tts.concurrency ||
    form.sentence_requests !== tts.sentence_requests;

  function draft(): TtsServerDraft {
    const out: TtsServerDraft = { base_url: form.base_url.trim() };
    if (form.api_key.trim()) out.api_key = form.api_key.trim();
    out.concurrency = concurrency;
    if (form.sentence_requests !== tts.sentence_requests) out.sentence_requests = form.sentence_requests;
    return out;
  }

  function submit(update: TtsServerDraft, after?: () => void) {
    save.mutate(
      { tts: update },
      {
        onSuccess: () => {
          after?.();
          // The voice list comes from the server now in effect.
          void queryClient.invalidateQueries({ queryKey: ["voices"] });
        },
      },
    );
  }

  const usingEnv = !tts.base_url;
  return (
    <section aria-labelledby="tts-server-h" className="flex flex-col gap-3 border-t border-border py-5">
      <div className="flex flex-col gap-1">
        <h3 id="tts-server-h" className="font-display text-[18px]">
          TTS server
        </h3>
        <p className={hint}>
          Any OpenAI-compatible speech server (/v1/audio/speech). Changing the server generates the audio again as books
          are played.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tts-base_url" className={fieldLabel}>
          Base URL
        </label>
        <input
          id="tts-base_url"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder={tts.env_base_url || "http://tts.example.local/v1"}
          value={form.base_url}
          onChange={(event) => setForm((current) => ({ ...current, base_url: event.target.value }))}
          className={input}
        />
        <p className={hint}>
          {usingEnv
            ? tts.env_base_url
              ? `Using TTS_BASE_URL from the server: ${tts.env_base_url}`
              : "No TTS server: enter a base URL, or set TTS_BASE_URL on the server."
            : `Leave the base URL empty to use TTS_BASE_URL${tts.env_base_url ? ` (${tts.env_base_url})` : ""} again.`}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tts-api_key" className={fieldLabel}>
          API key
        </label>
        <input
          id="tts-api_key"
          type="password"
          autoComplete="off"
          placeholder={tts.key_set ? `Saved (${tts.key_hint}). Leave empty to keep it` : "Optional for local servers"}
          value={form.api_key}
          onChange={(event) => setForm((current) => ({ ...current, api_key: event.target.value }))}
          className={input}
        />
        <p className={hint}>Sent only to the base URL above; the server’s TTS_API_KEY stays with TTS_BASE_URL.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tts-concurrency" className={fieldLabel}>
          Requests at once
        </label>
        <input
          id="tts-concurrency"
          type="number"
          inputMode="numeric"
          min={CONCURRENCY_MIN}
          max={CONCURRENCY_MAX}
          step={1}
          placeholder={`${tts.env_concurrency} (server default)`}
          value={form.concurrency}
          aria-invalid={concurrencyBad || undefined}
          onChange={(event) => setForm((current) => ({ ...current, concurrency: event.target.value }))}
          className={clsx(input, "max-w-[220px]")}
        />
        {concurrencyBad ? (
          <p className={clsx(hint, "text-danger")}>
            Enter a whole number from {CONCURRENCY_MIN} to {CONCURRENCY_MAX}.
          </p>
        ) : (
          <p className={hint}>
            Requests sent to the TTS server at once. A single-GPU server like IndexTTS runs one at a time; 2 keeps it
            busy without long queues.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span id="tts-requests-label" className={fieldLabel}>
          Requests
        </span>
        <div role="radiogroup" aria-labelledby="tts-requests-label" className="flex w-fit rounded-full bg-raised p-[3px]">
          {(
            [
              { value: false, label: "Whole segment" },
              { value: true, label: "One sentence each" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={sentences === value}
              onClick={() => setForm((current) => ({ ...current, sentence_requests: value }))}
              className={clsx(
                "tap inline-flex h-[34px] items-center whitespace-nowrap rounded-full px-3.5 text-base font-semibold",
                sentences === value ? "bg-fg text-on-fg" : "text-fg hover:bg-border",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={hint}>
          One sentence each keeps long generations consistent on servers that drift (VoxCPM2). IndexTTS doesn’t need it.
          Changing it regenerates audio as it is played.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Save TTS server"
          disabled={!dirty || concurrencyBad || save.isPending}
          onClick={() => submit(draft(), () => setForm((current) => ({ ...current, api_key: "" })))}
          className={savePill}
        >
          Save
        </button>
        <button
          type="button"
          aria-label="Test the TTS server"
          disabled={connection.running}
          onClick={() =>
            void connection.run(() => {
              const { base_url, api_key } = draft();
              return testTtsServer(api_key ? { base_url, api_key } : { base_url });
            })
          }
          className={outlinePill}
        >
          {connection.running ? "Testing…" : "Test connection"}
        </button>
        {tts.key_set && (
          <button
            type="button"
            aria-label="Remove TTS key"
            disabled={save.isPending}
            onClick={() => submit({ api_key: null })}
            className={clsx(outlinePill, "text-danger")}
          >
            Remove key
          </button>
        )}
      </div>
      <TestResultLine result={connection.result} label="TTS connection test" />
      {save.isError && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}
    </section>
  );
}

export function TtsServerPane() {
  const { data, error, isPending } = useIntegrations();
  if (isPending) return <div className="mt-4 h-40 animate-pulse rounded-md bg-raised" aria-busy="true" />;
  if (error instanceof Error)
    return (
      <p role="alert" className="pt-4 text-sm text-danger">
        Couldn’t load the TTS server settings — {error.message}
      </p>
    );
  return data?.tts ? <Settings tts={data.tts} /> : null;
}
