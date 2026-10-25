import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ListeningSettings } from "../api/settings";
import { SettingsPage } from "./SettingsPage";

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "alex-en", language: "en", display_name: "Alexandra", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    { id: "ashley-kr", language: "ko", description: null, available: false },
  ],
};

let serverSettings: ListeningSettings;
let settingsGetFails: boolean;
let putFails: boolean;

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
  serverSettings = { ...DEFAULT_SETTINGS };
  settingsGetFails = false;
  putFails = false;
  URL.createObjectURL = vi.fn(() => "blob:sample") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/voices/preview")) {
        return { ok: true, status: 200, blob: async () => new Blob(["opus-bytes"]) } as Response;
      }
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      if (url.includes("/me/settings")) {
        if (init?.method === "PUT") {
          if (putFails) return jsonResponse(500, { error: { code: "server_error", message: "no" } });
          const patch = JSON.parse(String(init.body)) as Partial<ListeningSettings>;
          serverSettings = { ...serverSettings, ...patch };
          return jsonResponse(200, { settings: serverSettings });
        }
        if (settingsGetFails) throw new Error("offline");
        return jsonResponse(200, { settings: serverSettings });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it("promises automatic saving and re-queries the engine when opened and from the button", async () => {
    renderSettings();
    expect((await screen.findByRole("status")).textContent).toMatch(/Changes save automatically/);
    await vi.waitFor(() => expect(callsTo("/voices?refresh=true")).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));
    await vi.waitFor(() => expect(callsTo("/voices?refresh=true")).toBe(2));
  });

  it("has no theme control — the app is dark only", async () => {
    renderSettings();
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("hydrates the listening settings from the server", async () => {
    serverSettings = { ...DEFAULT_SETTINGS, speed: 1.75, skip_back: 10, skip_forward: 45, auto_next: false };
    renderSettings();
    expect(await screen.findByRole("combobox", { name: "Default playback speed" })).toHaveProperty(
      "value",
      "1.75",
    );
    expect(screen.getByLabelText("Skip back in seconds")).toHaveProperty("value", "10");
    expect(screen.getByLabelText("Skip forward in seconds")).toHaveProperty("value", "45");
    expect(
      screen.getByRole("switch", { name: "Auto-play next chapter" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("PUTs only the changed keys and updates optimistically", async () => {
    renderSettings();
    const speed = await screen.findByRole("combobox", { name: "Default playback speed" });
    fireEvent.change(speed, { target: { value: "1.5" } });

    // Optimistic: the control and the offline mirror reflect the change at once.
    expect(speed).toHaveProperty("value", "1.5");
    expect(localStorage.getItem("folio-speed")).toBe("1.5");

    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ speed: 1.5 });
  });

  it("saves switches on change", async () => {
    renderSettings();
    const autoNext = await screen.findByRole("switch", { name: "Auto-play next chapter" });
    fireEvent.click(autoNext);
    expect(autoNext.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ auto_next: false });
  });

  it("coalesces a burst of edits into one PUT of the changed keys", async () => {
    renderSettings();
    const speed = await screen.findByRole("combobox", { name: "Default playback speed" });
    fireEvent.change(speed, { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText("Skip back in seconds"), { target: { value: "20" } });

    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ speed: 1.25, skip_back: 20 });
  });

  it("rejects a skip interval outside 5–120 without saving it", async () => {
    renderSettings();
    const back = await screen.findByLabelText("Skip back in seconds");
    fireEvent.change(back, { target: { value: "200" } });
    expect(back.getAttribute("aria-invalid")).toBe("true");
    expect(await screen.findByRole("alert")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settingsPutBodies()).toEqual([]);
  });

  it("falls back to localStorage when the settings request fails", async () => {
    settingsGetFails = true;
    localStorage.setItem("folio-speed", "1.25");
    localStorage.setItem("folio-voice-en", "ashley-en");
    renderSettings();
    expect(await screen.findByRole("combobox", { name: "Default playback speed" })).toHaveProperty(
      "value",
      "1.25",
    );
    expect(await screen.findByRole("combobox", { name: "Voice for English" })).toHaveProperty(
      "value",
      "ashley-en",
    );
  });

  it("groups one aligned row per language and labels voices for reading", async () => {
    renderSettings();
    const selects = await screen.findAllByRole("combobox", { name: /^Voice for / });
    expect(selects.map((select) => select.getAttribute("aria-label"))).toEqual([
      "Voice for English",
      "Voice for Japanese",
      "Voice for Korean",
      "Voice for Chinese, Simplified",
      "Voice for Chinese, Traditional",
    ]);
    // Same width everywhere so the control column lines up.
    for (const select of selects) expect(String(select.className)).toContain("w-[168px]");

    const en = selects[0]!;
    const labels = Array.from(en.querySelectorAll("option")).map((option) => option.textContent);
    expect(labels).toContain("Ashley"); // "ashley-en" parsed, not shown raw
    expect(labels).toContain("Alexandra"); // display_name wins
    expect(labels.some((label) => label === "ashley-en")).toBe(false);

    expect(await screen.findByText(/3 voices available from the TTS server/)).toBeTruthy();
  });

  it("preselects a voice without saving, then persists an explicit choice", async () => {
    renderSettings();
    const en = await screen.findByRole("combobox", { name: "Voice for English" });
    await vi.waitFor(() => expect(en).toHaveProperty("value", "ashley-en"));
    expect(settingsPutBodies()).toEqual([]);

    fireEvent.change(en, { target: { value: "alex-en" } });
    expect(localStorage.getItem("folio-voice-en")).toBe("alex-en");
    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ voices: { en: "alex-en" } });
  });

  it("keeps a saved voice the server no longer listed selected and marked", async () => {
    serverSettings = { ...DEFAULT_SETTINGS, voices: { en: "ghost-en" } };
    renderSettings();
    const en = await screen.findByRole("combobox", { name: "Voice for English" });
    expect(en).toHaveProperty("value", "ghost-en");
    expect(Array.from(en.querySelectorAll("option")).map((o) => o.textContent)).toContain(
      "ghost-en (no longer available)",
    );
  });

  it("disables language rows that have no voices", async () => {
    renderSettings();
    const zh = await screen.findByRole("combobox", { name: "Voice for Chinese, Simplified" });
    await vi.waitFor(() => expect(zh.hasAttribute("disabled")).toBe(true));
    expect(screen.getAllByText("No voices available for this language").length).toBeGreaterThan(0);
  });

  it("preview plays a sample and the same button stops it", async () => {
    renderSettings();
    await screen.findByRole("combobox", { name: "Voice for English" });
    const preview = screen.getByRole("button", { name: "Preview ashley-en" });

    fireEvent.click(preview);
    await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/voices/preview"))?.[1]?.body))).toEqual({ voice: "ashley-en" });

    fireEvent.click(preview);
    await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1));
  });

  it("shows an inline error and reverts the control when the save fails", async () => {
    putFails = true;
    renderSettings();
    const speed = await screen.findByRole("combobox", { name: "Default playback speed" });
    fireEvent.change(speed, { target: { value: "1.5" } });
    expect(speed).toHaveProperty("value", "1.5"); // optimistic first

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn/);
    await waitFor(() => expect(speed).toHaveProperty("value", "1")); // reverted
    expect(serverSettings.speed).toBe(1);
  });
});
