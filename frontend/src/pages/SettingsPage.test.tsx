import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ListeningSettings } from "../api/settings";
import { SettingsPage } from "./SettingsPage";

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    { id: "ashley-kr", language: "ko", description: null, available: false },
  ],
};

let serverSettings: ListeningSettings;
let settingsFails: boolean;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callsTo(fragment: string): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

function settingsPutBodies(): Partial<ListeningSettings>[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => String(input).includes("/me/settings") && init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Partial<ListeningSettings>);
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  serverSettings = { ...DEFAULT_SETTINGS };
  settingsFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      if (url.includes("/me/settings")) {
        if (init?.method === "PUT") {
          const patch = JSON.parse(String(init.body)) as Partial<ListeningSettings>;
          serverSettings = { ...serverSettings, ...patch };
          return jsonResponse(200, { settings: serverSettings });
        }
        if (settingsFails) throw new Error("offline");
        return jsonResponse(200, { settings: serverSettings });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  it("re-queries the engine with refresh=true when opened and from the button", async () => {
    renderSettings();
    await vi.waitFor(() => expect(callsTo("/voices?refresh=true")).toBe(1));
    await screen.findByRole("combobox", { name: "en voice" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));
    await vi.waitFor(() => expect(callsTo("/voices?refresh=true")).toBe(2));
  });

  it("persists the theme choice and clears the pin for system", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "dark" }));
    expect(localStorage.getItem("folio-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: "system" }));
    expect(localStorage.getItem("folio-theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("hydrates the listening settings from the server", async () => {
    serverSettings = { ...DEFAULT_SETTINGS, speed: 1.75, skip_back: 10, skip_forward: 45, auto_next: false };
    renderSettings();
    expect(await screen.findByLabelText("Default playback speed")).toHaveProperty("value", "1.75");
    expect(screen.getByLabelText("Back")).toHaveProperty("value", "10");
    expect(screen.getByLabelText("Forward")).toHaveProperty("value", "45");
    expect(screen.getByLabelText("Auto-play next chapter")).toHaveProperty("checked", false);
  });

  it("PUTs only the changed keys and updates optimistically", async () => {
    renderSettings();
    const speed = await screen.findByLabelText("Default playback speed");
    fireEvent.change(speed, { target: { value: "1.5" } });

    // Optimistic: the control and the offline mirror reflect the change at once.
    expect(speed).toHaveProperty("value", "1.5");
    expect(localStorage.getItem("folio-speed")).toBe("1.5");

    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ speed: 1.5 });
  });

  it("coalesces a burst of edits into one PUT of the changed keys", async () => {
    renderSettings();
    const speed = await screen.findByLabelText("Default playback speed");
    fireEvent.change(speed, { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Back"), { target: { value: "20" } });

    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ speed: 1.25, skip_back: 20 });
  });

  it("rejects a skip interval outside 5–120 without saving it", async () => {
    renderSettings();
    const back = await screen.findByLabelText("Back");
    fireEvent.change(back, { target: { value: "200" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settingsPutBodies()).toEqual([]);
  });

  it("falls back to localStorage when the settings request fails", async () => {
    settingsFails = true;
    localStorage.setItem("folio-speed", "1.25");
    localStorage.setItem("folio-voice-en", "ashley-en");
    renderSettings();
    expect(await screen.findByLabelText("Default playback speed")).toHaveProperty("value", "1.25");
    expect(await screen.findByRole("combobox", { name: "en voice" })).toHaveProperty("value", "ashley-en");
  });

  it("persists the per-language voice and marks unavailable voices", async () => {
    renderSettings();
    await screen.findByRole("option", { name: "ashley-en" });
    fireEvent.change(screen.getByRole("combobox", { name: "en voice" }), {
      target: { value: "ashley-en" },
    });
    expect(localStorage.getItem("folio-voice-en")).toBe("ashley-en");

    fireEvent.change(screen.getByRole("combobox", { name: "ko voice" }), {
      target: { value: "ashley-kr" },
    });
    expect(await screen.findByText(/is no longer available/i)).toBeTruthy();
  });
});
