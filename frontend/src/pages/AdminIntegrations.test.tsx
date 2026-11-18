import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminIntegrations } from "./AdminIntegrations";
import type { Integrations } from "../api/integrations";

let state: Integrations;
const calls: { url: string; method: string; body: unknown }[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  state = {
    google_books: { key_set: false, key_hint: null, env_key: false },
    language_model: { base_url: "", model: "", ocr_model: "", ocr: false, suggest: false, key_set: false, key_hint: null },
    style_prompts: false,
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
      if (url.endsWith("/language-model/test"))
        return json(200, { ok: true, message: "qwen answered in 120 ms.", reply: "ready" });
      if (url.endsWith("/language-model/test-ocr")) {
        const file = (body as FormData).get("file");
        return json(200, {
          ok: true,
          message: "qwen-vl read the page in 900 ms.",
          text: file ? "Chapter One" : "It was the best of times",
          expected: file ? null : "It was the best of times",
        });
      }
      return json(404, { error: { code: "not_found", message: "nope" } });
    }),
  );
});

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminIntegrations />
    </QueryClientProvider>,
  );
}

const lastPut = () => [...calls].reverse().find((c) => c.method === "PUT")?.body as Record<string, unknown>;

describe("AdminIntegrations", () => {
  it("saves and tests the Google Books key without ever showing it", async () => {
    renderIt();
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

  it("tests the language model as typed, keeping the saved key unless one is typed", async () => {
    state.language_model = { ...state.language_model, key_set: true, key_hint: "…abcd" };
    renderIt();
    fireEvent.change(await screen.findByLabelText("Base URL"), { target: { value: " http://vllm.local:8000/v1 " } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen" } });
    expect(screen.getByLabelText("API key").getAttribute("placeholder")).toContain("Saved (…abcd)");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("qwen answered in 120 ms.")).toBeTruthy();
    expect(screen.getByText("“ready”")).toBeTruthy();
    const test = calls.find((c) => c.url.endsWith("/language-model/test"))!;
    expect(test.body).toEqual({ base_url: "http://vllm.local:8000/v1", model: "qwen", ocr_model: "" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastPut()).toEqual({ language_model: { base_url: "http://vllm.local:8000/v1", model: "qwen", ocr_model: "" } }));
  });

  it("reads the sample page or an uploaded file and shows both texts", async () => {
    state.language_model = { ...state.language_model, base_url: "http://llm/v1", model: "qwen-vl" };
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Read the sample page" }));
    expect(await screen.findByText("qwen-vl read the page in 900 ms.")).toBeTruthy();
    expect(screen.getByText("The model read")).toBeTruthy();
    expect(screen.getByText("The page says")).toBeTruthy();

    const file = new File(["%PDF-1.7"], "page.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Page to read"), { target: { files: [file] } });
    });
    expect(await screen.findByText("Chapter One")).toBeTruthy();
    const form = [...calls].reverse().find((c) => c.url.endsWith("/test-ocr"))!.body as FormData;
    expect((form.get("file") as File).name).toBe("page.pdf");
    expect(form.get("model")).toBe("qwen-vl");
    expect(screen.queryByText("The page says")).toBeNull();
  });

  it("switches features on only once a model is saved, and explains when notes are not sent", async () => {
    renderIt();
    const ocr = await screen.findByRole("switch", { name: "Read scanned PDFs (OCR)" });
    expect((ocr as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save a base URL and model to switch these on.")).toBeTruthy();
    expect(screen.getByText(/style prompts are off/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://llm/v1" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect((screen.getByRole("switch", { name: "Read scanned PDFs (OCR)" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Suggest pronunciation and a delivery note" }));
    await waitFor(() => expect(lastPut()).toEqual({ language_model: { suggest: true } }));
  });
});
