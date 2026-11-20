import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TtsServerPane } from "./AdminTtsServer";
import type { Integrations, TtsServer } from "../api/integrations";

let tts: TtsServer;
const calls: { url: string; method: string; body: unknown }[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function integrations(): Integrations {
  return {
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
    style_prompts: true,
    tts,
  };
}

beforeEach(() => {
  calls.length = 0;
  tts = {
    base_url: "",
    env_base_url: "http://tts.example.local/v1",
    key_set: false,
    key_hint: null,
    concurrency: null,
    env_concurrency: 4,
    sentence_requests: null,
    env_request_chars: 0,
    source: "env",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/admin/integrations") && method === "PUT") {
        const update = (body as { tts: Record<string, unknown> }).tts;
        const { api_key, ...rest } = update;
        tts = { ...tts, ...(rest as Partial<TtsServer>) };
        if (api_key !== undefined) tts = { ...tts, key_set: Boolean(api_key), key_hint: api_key ? "…5678" : null };
        tts.source = tts.base_url ? "admin" : "env";
        return json(200, integrations());
      }
      if (url.endsWith("/admin/integrations")) return json(200, integrations());
      if (url.endsWith("/tts/test"))
        return json(200, { ok: true, message: "Reached the TTS server in 42 ms: 3 voices.", voices: 3, latency_ms: 42 });
      if (url.includes("/voices")) return json(200, { items: [] });
      return json(404, { error: { code: "not_found", message: "nope" } });
    }),
  );
});

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TtsServerPane />
    </QueryClientProvider>,
  );
  return client;
}

const lastPut = () => [...calls].reverse().find((c) => c.method === "PUT")?.body as Record<string, unknown>;

describe("TtsServerPane", () => {
  it("shows the server's TTS_BASE_URL while no URL is set here", async () => {
    renderIt();
    const base = await screen.findByLabelText("Base URL");
    expect((base as HTMLInputElement).value).toBe("");
    expect(base.getAttribute("placeholder")).toBe("http://tts.example.local/v1");
    expect(screen.getByText("Using TTS_BASE_URL from the server: http://tts.example.local/v1")).toBeTruthy();
    expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Requests at once").getAttribute("placeholder")).toBe("4 (server default)");
    expect(screen.getByText(/A single-GPU server like IndexTTS runs one at a time/)).toBeTruthy();
    expect(screen.getByText(/Changing the server generates the audio again/)).toBeTruthy();
    // TTS_REQUEST_CHARS=0 on the server: whole segment is in effect.
    const requests = screen.getByRole("radiogroup", { name: "Requests" });
    expect(within(requests).getByRole("radio", { name: "Whole segment" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: "Save TTS server" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tests the form as typed and saves it, then reloads the voices", async () => {
    const client = renderIt();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.change(await screen.findByLabelText("Base URL"), { target: { value: " http://vllm.dotslash.io:8880/v1 " } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-tts-5678" } });
    fireEvent.change(screen.getByLabelText("Requests at once"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("radio", { name: "One sentence each" }));

    fireEvent.click(screen.getByRole("button", { name: "Test the TTS server" }));
    expect(await screen.findByText("Reached the TTS server in 42 ms: 3 voices.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/tts/test"))?.body).toEqual({
      base_url: "http://vllm.dotslash.io:8880/v1",
      api_key: "sk-tts-5678",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save TTS server" }));
    await waitFor(() =>
      expect(lastPut()).toEqual({
        tts: {
          base_url: "http://vllm.dotslash.io:8880/v1",
          api_key: "sk-tts-5678",
          concurrency: 1,
          sentence_requests: true,
        },
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["voices"] }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("API key").getAttribute("placeholder")).toBe("Saved (…5678). Leave empty to keep it");
    expect(screen.getByText(/Leave the base URL empty to use TTS_BASE_URL/)).toBeTruthy();
  });

  it("clears back to the server's defaults and removes the key", async () => {
    tts = {
      ...tts,
      base_url: "http://vllm/v1",
      key_set: true,
      key_hint: "…1234",
      concurrency: 2,
      sentence_requests: true,
      source: "admin",
    };
    renderIt();
    const base = await screen.findByLabelText("Base URL");
    expect((base as HTMLInputElement).value).toBe("http://vllm/v1");
    expect((screen.getByLabelText("Requests at once") as HTMLInputElement).value).toBe("2");
    fireEvent.change(base, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Requests at once"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save TTS server" }));
    await waitFor(() => expect(lastPut()).toEqual({ tts: { base_url: "", concurrency: null } }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove TTS key" }));
    await waitFor(() => expect(lastPut()).toEqual({ tts: { api_key: null } }));
  });

  it("won't save a concurrency outside 1-16", async () => {
    renderIt();
    fireEvent.change(await screen.findByLabelText("Requests at once"), { target: { value: "40" } });
    expect(screen.getByText("Enter a whole number from 1 to 16.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save TTS server" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
