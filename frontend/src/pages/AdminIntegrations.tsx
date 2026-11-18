/** Admin → Integrations: the Google Books API key and the language model
 * (OpenAI-compatible) that reads scanned PDFs and suggests pronunciation rules
 * and delivery notes. Keys are write-only: the page shows whether one is set
 * and its last four characters. Every Test runs on the form as typed, before
 * saving (a key field left empty tests with the saved key). */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  testGoogleBooks,
  testLanguageModel,
  testOcr,
  useIntegrations,
  useSaveIntegrations,
  type Integrations,
  type LanguageModelDraft,
  type OcrResult,
  type TestResult,
} from "../api/integrations";
import { Icon } from "../components/Icon";
import { Switch } from "../components/Switch";

const input =
  "tap h-10 w-full rounded-md border border-border bg-raised px-3.5 text-md text-fg placeholder:text-fg-2";
const outlinePill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-transparent px-4 text-base font-semibold text-fg hover:bg-raised disabled:opacity-50";
const savePill =
  "tap inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-fg px-[18px] text-base font-bold text-on-fg hover:opacity-90 disabled:opacity-50";
const fieldLabel = "text-[13px] font-semibold";
const hint = "text-sm text-fg-2";

function Result({ result, label }: { result: TestResult | null; label: string }) {
  if (!result) return null;
  return (
    <p
      role="status"
      aria-label={label}
      className={clsx("flex items-start gap-1.5 text-sm", result.ok ? "text-fg" : "text-danger")}
    >
      <Icon name={result.ok ? "CircleCheck" : "TriangleAlert"} size={16} className="mt-0.5 shrink-0" />
      <span>{result.message}</span>
    </p>
  );
}

/** Run a test, turning a request failure into a failed result line. */
function useTest<T extends TestResult>() {
  const [result, setResult] = useState<T | null>(null);
  const [running, setRunning] = useState(false);
  async function run(call: () => Promise<T>) {
    setRunning(true);
    setResult(null);
    try {
      setResult(await call());
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "The test failed." } as T);
    } finally {
      setRunning(false);
    }
  }
  return { result, running, run };
}

function GoogleBooks({ data }: { data: Integrations }) {
  const save = useSaveIntegrations();
  const [key, setKey] = useState("");
  const test = useTest<TestResult>();
  const google = data.google_books;
  const status = google.key_set
    ? `A key is set (${google.key_hint}).`
    : google.env_key
      ? "Using the server’s GOOGLE_BOOKS_API_KEY."
      : "No key: Google answers most lookups with “too many requests” (HTTP 429).";
  return (
    <section aria-labelledby="google-h" className="flex flex-col gap-3 border-t border-border py-5">
      <div className="flex flex-col gap-1">
        <h3 id="google-h" className="font-display text-[18px]">
          Book metadata
        </h3>
        <p className={hint}>
          Titles, authors, descriptions and covers come from Open Library (no key needed) and Google Books, which is the
          stronger source for books in other languages. A free key from the Google Cloud console (enable the Books API)
          stops the rate limiting.
        </p>
      </div>
      <label htmlFor="google-key" className={fieldLabel}>
        Google Books API key
      </label>
      <input
        id="google-key"
        type="password"
        autoComplete="off"
        placeholder={google.key_set ? "Paste a new key to replace it" : "Paste the API key"}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        className={input}
      />
      <p className={hint}>{status}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!key.trim() || save.isPending}
          onClick={() => save.mutate({ google_books_api_key: key.trim() }, { onSuccess: () => setKey("") })}
          className={savePill}
        >
          Save key
        </button>
        <button
          type="button"
          disabled={test.running}
          onClick={() => void test.run(() => testGoogleBooks(key.trim() || undefined))}
          className={outlinePill}
        >
          {test.running ? "Testing…" : "Test"}
        </button>
        {google.key_set && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ google_books_api_key: null })}
            className={clsx(outlinePill, "text-danger")}
          >
            Remove key
          </button>
        )}
      </div>
      <Result result={test.result} label="Google Books test" />
      {save.isError && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}
    </section>
  );
}

interface Form {
  base_url: string;
  model: string;
  ocr_model: string;
  api_key: string;
}

function LanguageModel({ data }: { data: Integrations }) {
  const save = useSaveIntegrations();
  const llm = data.language_model;
  const [form, setForm] = useState<Form>({ base_url: llm.base_url, model: llm.model, ocr_model: llm.ocr_model, api_key: "" });
  const connection = useTest<TestResult>();
  const ocr = useTest<OcrResult>();
  const fileInput = useRef<HTMLInputElement>(null);
  // A save (or a switch) refreshes the saved values; keep typed text otherwise.
  useEffect(() => {
    setForm((current) => ({ ...current, base_url: llm.base_url, model: llm.model, ocr_model: llm.ocr_model }));
  }, [llm.base_url, llm.model, llm.ocr_model]);

  const configured = Boolean(llm.base_url && llm.model);
  const dirty =
    form.base_url.trim() !== llm.base_url || form.model.trim() !== llm.model || form.ocr_model.trim() !== llm.ocr_model || form.api_key.trim() !== "";

  /** The form as typed; an empty key field keeps (and tests with) the saved key. */
  function draft(): LanguageModelDraft {
    const out: LanguageModelDraft = { base_url: form.base_url.trim(), model: form.model.trim(), ocr_model: form.ocr_model.trim() };
    if (form.api_key.trim()) out.api_key = form.api_key.trim();
    return out;
  }

  const field = (name: keyof Form, label: string, placeholder: string, type = "text") => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`llm-${name}`} className={fieldLabel}>
        {label}
      </label>
      <input
        id={`llm-${name}`}
        type={type}
        autoComplete="off"
        placeholder={placeholder}
        value={form[name]}
        onChange={(event) => setForm((current) => ({ ...current, [name]: event.target.value }))}
        className={input}
      />
    </div>
  );

  return (
    <section aria-labelledby="llm-h" className="flex flex-col gap-3 border-t border-border py-5">
      <div className="flex flex-col gap-1">
        <h3 id="llm-h" className="font-display text-[18px]">
          Language model
        </h3>
        <p className={hint}>
          Any OpenAI-compatible chat completions endpoint: OpenAI, a vLLM or Ollama server, and similar. It reads scanned
          PDFs and suggests pronunciation rules and a delivery note for each book.
        </p>
      </div>
      {field("base_url", "Base URL", "https://api.openai.com/v1")}
      {field("api_key", "API key", llm.key_set ? `Saved (${llm.key_hint}). Leave empty to keep it` : "Optional for local servers", "password")}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("model", "Model", "gpt-4o-mini")}
        {field("ocr_model", "Reading model (OCR)", "Same as the model")}
      </div>
      <p className={hint}>OCR needs a model that reads images. Leave the reading model empty to use the main model.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ language_model: draft() }, { onSuccess: () => setForm((current) => ({ ...current, api_key: "" })) })}
          className={savePill}
        >
          Save
        </button>
        <button
          type="button"
          disabled={connection.running || !form.base_url.trim() || !form.model.trim()}
          onClick={() => void connection.run(() => testLanguageModel(draft()))}
          className={outlinePill}
        >
          {connection.running ? "Testing…" : "Test connection"}
        </button>
        {llm.key_set && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ language_model: { api_key: null } })}
            className={clsx(outlinePill, "text-danger")}
          >
            Remove key
          </button>
        )}
      </div>
      <Result result={connection.result} label="Connection test" />
      {connection.result?.ok && connection.result.reply && (
        <p className={hint}>
          The model replied: <span className="text-fg">“{connection.result.reply}”</span>
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-sm text-danger">
          {save.error.message}
        </p>
      )}

      <div className="flex flex-col gap-2 pt-3">
        <span className={fieldLabel}>Test OCR</span>
        <p className={hint}>Reads a printed sample page, or a page image or PDF of your own (its first page).</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={ocr.running || !form.base_url.trim() || !form.model.trim()}
            onClick={() => void ocr.run(() => testOcr(draft()))}
            className={outlinePill}
          >
            {ocr.running ? "Reading…" : "Read the sample page"}
          </button>
          <button
            type="button"
            disabled={ocr.running || !form.base_url.trim() || !form.model.trim()}
            onClick={() => fileInput.current?.click()}
            className={outlinePill}
          >
            Read a file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
            aria-label="Page to read"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void ocr.run(() => testOcr(draft(), file));
            }}
          />
        </div>
        <Result result={ocr.result} label="OCR test" />
        {ocr.result?.text && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className={hint}>The model read</span>
              <pre className="whitespace-pre-wrap rounded-md bg-raised p-3 font-ui text-sm text-fg">{ocr.result.text}</pre>
            </div>
            {ocr.result.expected && (
              <div className="flex flex-col gap-1">
                <span className={hint}>The page says</span>
                <pre className="whitespace-pre-wrap rounded-md bg-raised p-3 font-ui text-sm text-fg">{ocr.result.expected}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 pt-3">
        <FeatureSwitch
          label="Read scanned PDFs (OCR)"
          description="Pages without a text layer are read by the model at import. Reprocess a book marked Needs OCR to read it."
          checked={llm.ocr}
          disabled={!configured || save.isPending}
          onChange={(next) => save.mutate({ language_model: { ocr: next } })}
        />
        <FeatureSwitch
          label="Suggest pronunciation and a delivery note"
          description="After each import the model proposes how to say unusual names and foreign words (used only once you accept them under the book’s Manage tab) and a short narration note."
          checked={llm.suggest}
          disabled={!configured || save.isPending}
          onChange={(next) => save.mutate({ language_model: { suggest: next } })}
        />
        {!configured && <p className={hint}>Save a base URL and model to switch these on.</p>}
      </div>

      {!data.style_prompts && (
        <p className={clsx(hint, "rounded-md bg-raised p-3")}>
          Delivery notes (the book’s and each voice’s) are not sent to this server’s speech engine: style prompts are off
          (<span className="font-mono">TTS_INSTRUCTIONS=false</span>), because a prompt makes a cloned VoxCPM2 voice less
          consistent. Notes are kept for an engine that takes them. Pronunciation rules work either way.
        </p>
      )}
    </section>
  );
}

function FeatureSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className={clsx("flex items-center justify-between gap-4 py-1.5", disabled && "opacity-50")}>
      <div className="flex min-w-0 flex-col">
        <span className="text-md font-medium">{label}</span>
        <span className={hint}>{description}</span>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function AdminIntegrations() {
  const { data, error, isPending } = useIntegrations();
  return (
    <section aria-labelledby="integrations-h" className="flex flex-col">
      <h2 id="integrations-h" className="pb-2 font-display text-xl">
        Integrations
      </h2>
      <p className={clsx(hint, "pb-2")}>Keys are stored on the server and never shown again in full.</p>
      {isPending && <div className="h-40 animate-pulse rounded-md bg-raised" aria-busy="true" />}
      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
      {data && (
        <>
          <GoogleBooks data={data} />
          <LanguageModel data={data} />
        </>
      )}
    </section>
  );
}
