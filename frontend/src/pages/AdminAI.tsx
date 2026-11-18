/** Admin → AI: the language model (any OpenAI-compatible endpoint), then OCR,
 * then suggestions — each its own group. Models are listed from the endpoint
 * (GET {base_url}/models, asked by the server so the key stays there); when the
 * list can't be read the model is typed instead. Every Test runs on the form as
 * typed, before saving (an empty key field uses the saved key). */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  listModels,
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
import {
  TestResultLine,
  adminHint as hint,
  adminInput as input,
  adminLabel as fieldLabel,
  adminOutlinePill as outlinePill,
  adminSavePill as savePill,
  useTest,
} from "../components/TestResult";

const group = "flex flex-col gap-3 border-t border-border py-5";
const groupTitle = "font-display text-[18px]";

interface Models {
  loading: boolean;
  list: string[] | null;
  message: string | null;
}

/** A model chooser: the endpoint's list when it could be read, else a text box. */
function ModelPicker({
  id,
  label,
  value,
  onChange,
  models,
  onRefresh,
  sameAsModel = false,
  disabled = false,
  showStatus = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  models: Models;
  onRefresh: () => void;
  /** Offer "Same as the model" (an empty value). */
  sameAsModel?: boolean;
  disabled?: boolean;
  /** Show the list's loading / error line (once per page: under the main model). */
  showStatus?: boolean;
}) {
  const listed = models.list && models.list.length > 0 ? models.list : null;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        {listed ? (
          <select
            id={id}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className={clsx(input, "min-w-0 flex-1 disabled:opacity-50")}
          >
            {sameAsModel ? <option value="">Same as the model</option> : !value && <option value="">Choose a model</option>}
            {value && !listed.includes(value) && <option value={value}>{value} (not listed)</option>}
            {listed.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            value={value}
            disabled={disabled}
            autoComplete="off"
            placeholder={sameAsModel ? "Same as the model" : "Model name"}
            onChange={(event) => onChange(event.target.value)}
            className={clsx(input, "min-w-0 flex-1 disabled:opacity-50")}
          />
        )}
        <button
          type="button"
          aria-label={`Refresh the ${label.toLowerCase()} list`}
          title="Refresh the list"
          disabled={models.loading}
          onClick={onRefresh}
          className="tap grid size-10 shrink-0 place-items-center rounded-full text-fg hover:bg-raised disabled:opacity-40"
        >
          <Icon name="RefreshCw" size={18} />
        </button>
      </div>
      {showStatus && models.loading && <p className={hint}>Loading models…</p>}
      {showStatus && !models.loading && models.message && <p className={clsx(hint, "text-danger")}>{models.message}</p>}
    </div>
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

interface Form {
  base_url: string;
  api_key: string;
  model: string;
}

function Settings({ data }: { data: Integrations }) {
  const save = useSaveIntegrations();
  const llm = data.language_model;
  const [form, setForm] = useState<Form>({ base_url: llm.base_url, api_key: "", model: llm.model });
  const [models, setModels] = useState<Models>({ loading: false, list: null, message: null });
  const connection = useTest<TestResult>();
  const ocr = useTest<OcrResult>();
  const fileInput = useRef<HTMLInputElement>(null);
  const loadedFrom = useRef<string | null>(null);
  useEffect(() => {
    setForm((current) => ({ ...current, base_url: llm.base_url, model: llm.model }));
  }, [llm.base_url, llm.model]);

  const configured = Boolean(llm.base_url && llm.model);
  const dirty = form.base_url.trim() !== llm.base_url || form.model.trim() !== llm.model || form.api_key.trim() !== "";
  const ready = Boolean(form.base_url.trim() && form.model.trim());

  /** The form as typed; an empty key field keeps (and tests with) the saved key. */
  const draft = useCallback((): LanguageModelDraft => {
    const out: LanguageModelDraft = { base_url: form.base_url.trim(), model: form.model.trim() };
    if (form.api_key.trim()) out.api_key = form.api_key.trim();
    return out;
  }, [form]);

  const loadModels = useCallback(async (from: LanguageModelDraft) => {
    if (!from.base_url) return;
    loadedFrom.current = from.base_url;
    setModels((current) => ({ ...current, loading: true, message: null }));
    try {
      const result = await listModels({ base_url: from.base_url, ...(from.api_key ? { api_key: from.api_key } : {}) });
      setModels({ loading: false, list: result.ok ? result.models : null, message: result.ok ? null : result.message ?? null });
    } catch (error) {
      setModels({ loading: false, list: null, message: error instanceof Error ? error.message : "Could not list the models." });
    }
  }, []);

  // The saved endpoint's models, once.
  useEffect(() => {
    if (llm.base_url && loadedFrom.current === null) void loadModels({ base_url: llm.base_url });
  }, [llm.base_url, loadModels]);

  const field = (name: "base_url" | "api_key", label: string, placeholder: string, type = "text") => (
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
        // A new endpoint (or key) lists its own models.
        onBlur={() => {
          const next = draft();
          if (next.base_url && (name === "api_key" ? Boolean(next.api_key) : next.base_url !== loadedFrom.current)) {
            void loadModels(next);
          }
        }}
        className={input}
      />
    </div>
  );

  return (
    <>
      <section aria-labelledby="llm-h" className={group}>
        <div className="flex flex-col gap-1">
          <h3 id="llm-h" className={groupTitle}>
            Language model
          </h3>
          <p className={hint}>
            Any OpenAI-compatible chat completions endpoint: OpenAI, LiteLLM, a vLLM or Ollama server, and similar.
          </p>
        </div>
        {field("base_url", "Base URL", "https://api.openai.com/v1")}
        {field("api_key", "API key", llm.key_set ? `Saved (${llm.key_hint}). Leave empty to keep it` : "Optional for local servers", "password")}
        <ModelPicker
          id="llm-model"
          label="Model"
          value={form.model}
          onChange={(model) => setForm((current) => ({ ...current, model }))}
          models={models}
          onRefresh={() => void loadModels(draft())}
        />
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
            disabled={connection.running || !ready}
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
        <TestResultLine result={connection.result} label="Connection test" />
        {connection.result?.ok && connection.result.reply && (
          <p className={hint}>
            The model replied: <span className="text-fg">“{connection.result.reply}”</span>
          </p>
        )}
        <FeatureSwitch
          label="Let the model think"
          description="Off: Folio asks the model to answer straight away. Reading pages and suggesting rules don’t need a model to reason first, and thinking makes every request slower."
          checked={llm.thinking}
          disabled={!configured || save.isPending}
          onChange={(next) => save.mutate({ language_model: { thinking: next } })}
        />
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        )}
      </section>

      <section aria-labelledby="ocr-h" className={group}>
        <div className="flex flex-col gap-1">
          <h3 id="ocr-h" className={groupTitle}>
            OCR
          </h3>
          <p className={hint}>
            Scanned PDFs have no text to read aloud. The model can read their pages; it must be one that reads images.
          </p>
        </div>
        <ModelPicker
          id="llm-ocr-model"
          label="Reading model"
          value={llm.ocr_model}
          sameAsModel
          showStatus={false}
          disabled={!configured || save.isPending}
          onChange={(ocr_model) => save.mutate({ language_model: { ocr_model } })}
          models={models}
          onRefresh={() => void loadModels(draft())}
        />
        <FeatureSwitch
          label="Read scanned PDFs"
          description="Pages without a text layer are read by the model at import. Reprocess a book marked Needs OCR to read it."
          checked={llm.ocr}
          disabled={!configured || save.isPending}
          onChange={(next) => save.mutate({ language_model: { ocr: next } })}
        />
        <div className="flex flex-col gap-2">
          <span className={fieldLabel}>Test OCR</span>
          <p className={hint}>Reads a printed sample page, or a page image or PDF of your own (its first page).</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={ocr.running || !ready}
              onClick={() => void ocr.run(() => testOcr({ ...draft(), ocr_model: llm.ocr_model }))}
              className={outlinePill}
            >
              {ocr.running ? "Reading…" : "Read the sample page"}
            </button>
            <button type="button" disabled={ocr.running || !ready} onClick={() => fileInput.current?.click()} className={outlinePill}>
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
                if (file) void ocr.run(() => testOcr({ ...draft(), ocr_model: llm.ocr_model }, file));
              }}
            />
          </div>
          <TestResultLine result={ocr.result} label="OCR test" />
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
      </section>

      <section aria-labelledby="suggest-h" className={group}>
        <h3 id="suggest-h" className={groupTitle}>
          Pronunciation and delivery notes
        </h3>
        <FeatureSwitch
          label="Suggest pronunciation and a delivery note"
          description="After each import the model proposes how to say unusual names and foreign words (used only once you accept them under the book’s Manage tab) and a short narration note."
          checked={llm.suggest}
          disabled={!configured || save.isPending}
          onChange={(next) => save.mutate({ language_model: { suggest: next } })}
        />
        <p className={hint}>
          {data.style_prompts
            ? "Delivery notes are sent to the speech engine with each voice’s instructions."
            : "Delivery notes are kept but not sent: style prompts are off under Voices. Pronunciation rules work either way."}
        </p>
      </section>
      {!configured && <p className={hint}>Save a base URL and model to switch these features on.</p>}
    </>
  );
}

export function AdminAI() {
  const { data, error, isPending } = useIntegrations();
  return (
    <section aria-labelledby="ai-h" className="flex flex-col">
      <h2 id="ai-h" className="pb-2 font-display text-xl">
        AI
      </h2>
      <p className={clsx(hint, "pb-2")}>
        A language model reads scanned PDFs and suggests pronunciation rules and delivery notes. Keys are stored on the
        server and never shown again in full.
      </p>
      {isPending && <div className="h-40 animate-pulse rounded-md bg-raised" aria-busy="true" />}
      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
      {data && <Settings data={data} />}
    </section>
  );
}
