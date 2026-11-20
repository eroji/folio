import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAI } from "./AdminAI";
import { AdminMetadata } from "./AdminMetadata";
import type { Integrations } from "../api/integrations";

let state: Integrations;
let models: string[] | null;
const calls: { url: string; method: string; body: unknown }[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  models = ["uncensored", "utility"];
  state = {
    google_books: { key_set: false, key_hint: null, env_key: false },
    language_model: {
      base_url: "",
      model: "",
      ocr_model: "",
      ocr: false,
      suggest: false,
      thinking: false,
      key_set: false,
      key_hint: null,
    },
    style_prompts: false,
    tts: {
      base_url: "",
      env_base_url: "",
      key_set: false,
      key_hint: null,
      concurrency: null,
      env_concurrency: 4,
      sentence_requests: null,
      env_request_chars: 0,
      source: "none",
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/admin/integrations") && method === "PUT") {
        const update = body as { google_books_api_key?: string | null; language_model?: Record<string, unknown> };
        if ("google_books_api_key" in update) {
          const key = update.google_books_api_key;
          state.google_books = { ...state.google_books, key_set: Boolean(key), key_hint: key ? `…${key.slice(-4)}` : null };
        }
        if (update.language_model) {
          const { api_key, ...rest } = update.language_model;
          state.language_model = { ...state.language_model, ...rest };
          if (api_key !== undefined) state.language_model.key_set = Boolean(api_key);
        }
        return json(200, state);
      }
      if (url.endsWith("/admin/integrations")) return json(200, state);
      if (url.endsWith("/google-books/test")) return json(200, { ok: true, message: "Google Books answered with this key." });
      if (url.endsWith("/language-model/models"))
        return json(200, models ? { ok: true, models } : { ok: false, models: [], message: "Listing models returned HTTP 404." });
      if (url.endsWith("/language-model/test"))
        return json(200, { ok: true, message: "uncensored answered in 120 ms.", reply: "ready" });
      if (url.endsWith("/language-model/test-ocr")) {
        const file = (body as FormData).get("file");
        return json(200, {
          ok: true,
          message: "utility read the page in 900 ms.",
          text: file ? "Chapter One" : "It was the best of times",
          expected: file ? null : "It was the best of times",
        });
      }
      return json(404, { error: { code: "not_found", message: "nope" } });
    }),
  );
});

function renderIt(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const lastPut = () => [...calls].reverse().find((c) => c.method === "PUT")?.body as Record<string, unknown>;

/** A model control is 280px wide, not the whole column, and its native arrow is
 * replaced by a chevron 20px from the right edge. */
function expectPicker(control: HTMLElement, chevron = true) {
  const wrapper = control.parentElement as HTMLElement;
  expect(wrapper.className).toContain("w-[280px]");
  expect(wrapper.className).toContain("max-w-full");
  expect(wrapper.className).not.toMatch(/(^|\s)(w-full|flex-1|min-w-0)(\s|$)/);
  const arrow = wrapper.querySelector("svg");
  expect(Boolean(arrow && (arrow.getAttribute("class") ?? "").includes("right-5"))).toBe(chevron);
}

describe("AdminMetadata", () => {
  it("saves and tests the Google Books key without ever showing it", async () => {
    renderIt(<AdminMetadata />);
    const input = await screen.findByLabelText("Google Books API key");
    expect(screen.getByText(/No key: Google answers most lookups/)).toBeTruthy();
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "AIza-new-key-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Google Books answered with this key.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/google-books/test"))?.body).toEqual({ api_key: "AIza-new-key-1234" });

    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(screen.getByText("A key is set (…1234).")).toBeTruthy());
    expect(lastPut()).toEqual({ google_books_api_key: "AIza-new-key-1234" });
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(lastPut()).toEqual({ google_books_api_key: null }));
  });
});

describe("AdminAI", () => {
  it("lists the endpoint's models once a base URL is entered, and tests the form as typed", async () => {
    state.language_model = { ...state.language_model, key_set: true, key_hint: "…abcd" };
    renderIt(<AdminAI />);
    const base = await screen.findByLabelText("Base URL");
    fireEvent.change(base, { target: { value: " https://litellm.local/v1 " } });
    fireEvent.blur(base);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/language-model/models"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/language-model/models"))?.body).toEqual({ base_url: "https://litellm.local/v1" });
    const picker = await screen.findByRole("combobox", { name: "Model" });
    expectPicker(picker);
    expect(picker.className).toContain("appearance-none");
    expect(picker.className).toContain("pr-12");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a model", "uncensored", "utility"]);
    fireEvent.change(picker, { target: { value: "uncensored" } });

    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("....");
    expect(screen.queryByText(/Saved \(/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("uncensored answered in 120 ms.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/language-model/test"))?.body).toEqual({
      base_url: "https://litellm.local/v1",
      model: "uncensored",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastPut()).toEqual({ language_model: { base_url: "https://litellm.local/v1", model: "uncensored" } }),
    );
    await waitFor(() => expect(key.placeholder).toBe("...."));
    expect(key.value).toBe("");
  });

  it("masks the key with a placeholder once it is saved", async () => {
    state.language_model = { ...state.language_model, base_url: "https://llm/v1", model: "uncensored" };
    renderIt(<AdminAI />);
    const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(key.placeholder).toBe("Optional for local servers");
    fireEvent.change(key, { target: { value: "sk-secret-9025" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastPut()).toEqual({
        language_model: { base_url: "https://llm/v1", model: "uncensored", api_key: "sk-secret-9025" },
      }),
    );
    await waitFor(() => expect(key.placeholder).toBe("...."));
    expect(key.value).toBe("");
    expect(screen.queryByText(/Saved \(/)).toBeNull();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
  });

  it("falls back to typing the model when the list can't be read", async () => {
    models = null;
    state.language_model = { ...state.language_model, base_url: "https://llm/v1", model: "gpt-x" };
    renderIt(<AdminAI />);
    expect(await screen.findByText("Listing models returned HTTP 404.")).toBeTruthy();
    const typed = screen.getByRole("textbox", { name: "Model" });
    expect((typed as HTMLInputElement).value).toBe("gpt-x");
    expectPicker(typed, false);
  });

  it("keeps a saved model that the endpoint no longer lists", async () => {
    state.language_model = { ...state.language_model, base_url: "https://llm/v1", model: "retired" };
    renderIt(<AdminAI />);
    const picker = await screen.findByRole("combobox", { name: "Model" });
    expect((picker as HTMLSelectElement).value).toBe("retired");
    expect(within(picker).getByRole("option", { name: "retired (not listed)" })).toBeTruthy();
  });

  it("puts OCR in its own group below the model, with its reading model saved on choice", async () => {
    state.language_model = { ...state.language_model, base_url: "https://llm/v1", model: "uncensored" };
    renderIt(<AdminAI />);
    const groups = await screen.findAllByRole("heading", { level: 3 });
    expect(groups.map((h) => h.textContent)).toEqual(["Language model", "OCR", "Pronunciation and delivery notes"]);
    const ocr = screen.getByRole("region", { name: "OCR" });
    const reading = await within(ocr).findByRole("combobox", { name: "Reading model" });
    expectPicker(reading);
    expect(reading.className).toContain("appearance-none");
    expect((reading as HTMLSelectElement).value).toBe("");
    expect(within(reading).getAllByRole("option")[0]!.textContent).toBe("Same as the model");
    fireEvent.change(reading, { target: { value: "utility" } });
    await waitFor(() => expect(lastPut()).toEqual({ language_model: { ocr_model: "utility" } }));

    fireEvent.click(within(ocr).getByRole("button", { name: "Read the sample page" }));
    expect(await screen.findByText("utility read the page in 900 ms.")).toBeTruthy();
    expect(screen.getByText("The page says")).toBeTruthy();
    const file = new File(["%PDF-1.7"], "page.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Page to read"), { target: { files: [file] } });
    });
    expect(await screen.findByText("Chapter One")).toBeTruthy();
    const form = [...calls].reverse().find((c) => c.url.endsWith("/test-ocr"))!.body as FormData;
    expect((form.get("file") as File).name).toBe("page.pdf");
    expect(form.get("ocr_model")).toBe("utility");
  });

  it("thinking is off by default and the switches need a saved model", async () => {
    renderIt(<AdminAI />);
    const think = await screen.findByRole("switch", { name: "Let the model think" });
    expect(think.getAttribute("aria-checked")).toBe("false");
    expect((think as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Read scanned PDFs" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not sent: style prompts are off under Voices/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://llm/v1" } });
    fireEvent.change(await screen.findByRole("textbox", { name: "Model" }), { target: { value: "uncensored" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Let the model think" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: "Suggest pronunciation and a delivery note" }));
    await waitFor(() => expect(lastPut()).toEqual({ language_model: { suggest: true } }));
  });
});
