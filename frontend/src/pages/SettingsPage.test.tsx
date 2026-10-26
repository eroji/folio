import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ListeningSettings } from "../api/settings";
import { SettingsPage } from "./SettingsPage";

/** Mirrors the App routes for /settings so the URL-driven tabs are real. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

// Server shape after the voices redesign: defaults per base language,
// zh variants folded into one zh group, no Korean voices at all.
const VOICES = {
  defaults: { en: "alex-en", ja: null, zh: "wei-zh" },
  items: [
    { id: "ashley-en", language: "en", description: null, available: true, on_server: true, display_name: "Ashley" },
    { id: "alex-en", language: "en", description: null, available: true, on_server: true, display_name: "Alexandra" },
    { id: "tanaka-ja", language: "ja", description: null, available: true, on_server: true },
    { id: "wei-zh", language: "zh-CN", description: null, available: true, on_server: true, display_name: "Wei" },
    { id: "mei-zh", language: "zh-TW", description: null, available: true, on_server: true, display_name: "Mei" },
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

function settingsPutBodies(): Partial<ListeningSettings>[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([input, init]) => String(input).includes("/me/settings") && init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Partial<ListeningSettings>);
}

function optionLabels(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? "");
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

function renderSettings(entry = "/settings/playback"): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <Routes>
          <Route path="/settings" element={<Navigate to="/settings/playback" replace />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  it("redirects /settings to /settings/playback", async () => {
    renderSettings("/settings");
    expect(await screen.findByLabelText("Skip back in seconds")).toBeTruthy();
    expect((await screen.findByRole("tab", { name: "Playback" })).getAttribute("aria-selected")).toBe(
      "true",
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/settings/playback"),
    );
  });

  it("selects the section from the URL and updates the URL on click", async () => {
    renderSettings("/settings/voices");
    expect(await screen.findByRole("combobox", { name: "Voice for English" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Voices" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Playback" }));
    expect(await screen.findByLabelText("Skip back in seconds")).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/settings/playback"),
    );
  });

  it("offers only the Playback and Voices sections — no Theme", async () => {
    renderSettings();
    await screen.findByRole("heading", { name: "Profile" });
    const tabs = screen.getByRole("tablist", { name: "Profile sections" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Playback",
      "Voices",
    ]);
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.queryByText("Theme")).toBeNull();
  });

  it("arrow keys move selection, focus and URL between the tabs", async () => {
    renderSettings();
    const playback = await screen.findByRole("tab", { name: "Playback" });
    fireEvent.keyDown(playback, { key: "ArrowRight" });
    const voices = screen.getByRole("tab", { name: "Voices" });
    expect(voices.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(voices);
    expect(await screen.findByRole("combobox", { name: "Voice for English" })).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/settings/voices"),
    );

    fireEvent.keyDown(voices, { key: "ArrowRight" }); // wraps around
    expect(screen.getByRole("tab", { name: "Playback" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByLabelText("Skip back in seconds")).toBeTruthy();
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

    expect(speed).toHaveProperty("value", "1.5");
    expect(localStorage.getItem("folio-speed")).toBe("1.5");

    await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
    expect(settingsPutBodies()[0]).toEqual({ speed: 1.5 });
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
    renderSettings();
    expect(await screen.findByRole("combobox", { name: "Default playback speed" })).toHaveProperty(
      "value",
      "1.25",
    );
  });

  it("shows an inline error under the row and reverts the control when the save fails", async () => {
    putFails = true;
    renderSettings();
    const speed = await screen.findByRole("combobox", { name: "Default playback speed" });
    fireEvent.change(speed, { target: { value: "1.5" } });
    expect(speed).toHaveProperty("value", "1.5"); // optimistic first

    const playback = await screen.findByRole("region", { name: "Playback" });
    const alert = await within(playback).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn/);
    await waitFor(() => expect(speed).toHaveProperty("value", "1")); // reverted
    expect(serverSettings.speed).toBe(1);
  });

  describe("voices", () => {
    it("shows one row per language with voices, folding Chinese variants", async () => {
      renderSettings("/settings/voices");
      const selects = await screen.findAllByRole("combobox", { name: /^Voice for / });
      expect(selects.map((select) => select.getAttribute("aria-label"))).toEqual([
        "Voice for English",
        "Voice for Japanese",
        "Voice for Chinese",
      ]);
      expect(screen.queryByRole("combobox", { name: /Korean|zh/ })).toBeNull();
      expect(screen.getByText("zh")).toBeTruthy(); // secondary code on the Chinese row
      expect(screen.queryByText("zh-TW")).toBeNull();
      // Same width everywhere so the control column lines up.
      for (const select of selects)
        expect(String(select.parentElement?.getAttribute("class"))).toContain("w-[220px]");
    });

    it("lists Server default first and saves null when it is chosen", async () => {
      renderSettings("/settings/voices");
      const en = await screen.findByRole("combobox", { name: "Voice for English" });
      expect(optionLabels(en)[0]).toBe("Server default (Alexandra)");
      expect(en).toHaveProperty("value", ""); // unpinned = server default, nothing saved
      expect(settingsPutBodies()).toEqual([]);

      fireEvent.change(en, { target: { value: "ashley-en" } });
      await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
      expect(settingsPutBodies()[0]).toEqual({ voices: { en: "ashley-en" } });

      fireEvent.change(en, { target: { value: "" } });
      await waitFor(() => expect(settingsPutBodies()).toHaveLength(2));
      expect(settingsPutBodies()[1]).toEqual({ voices: { en: null } });
      expect(localStorage.getItem("folio-voice-en")).toBeNull();
    });

    it("labels voices by display name, never raw ids", async () => {
      renderSettings("/settings/voices");
      const en = await screen.findByRole("combobox", { name: "Voice for English" });
      expect(optionLabels(en)).toEqual(["Server default (Alexandra)", "Alexandra", "Ashley"]);
      const ja = screen.getByRole("combobox", { name: "Voice for Japanese" });
      expect(optionLabels(ja)).toEqual(["Server default", "Tanaka"]); // derived from the id
    });

    it("folds a legacy zh-TW pin into the zh row and saves it under zh", async () => {
      serverSettings = { ...DEFAULT_SETTINGS, voices: { "zh-TW": "mei-zh" } };
      renderSettings("/settings/voices");
      const zh = await screen.findByRole("combobox", { name: "Voice for Chinese" });
      expect(zh).toHaveProperty("value", "mei-zh");

      fireEvent.change(zh, { target: { value: "wei-zh" } });
      await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
      expect(settingsPutBodies()[0]).toEqual({ voices: { zh: "wei-zh" } });
    });

    it("marks a pinned voice gone from the server until the row changes", async () => {
      serverSettings = { ...DEFAULT_SETTINGS, voices: { en: "ghost-en" } };
      renderSettings("/settings/voices");
      const en = await screen.findByRole("combobox", { name: "Voice for English" });
      expect(en).toHaveProperty("value", "ghost-en");
      expect(optionLabels(en)).toContain("Ghost (no longer available)");

      fireEvent.change(en, { target: { value: "alex-en" } });
      await waitFor(() => expect(settingsPutBodies()).toHaveLength(1));
      expect(settingsPutBodies()[0]).toEqual({ voices: { en: "alex-en" } });
      expect(optionLabels(en)).not.toContain("Ghost (no longer available)");
    });

    it("preview plays a sample and the same button stops it", async () => {
      serverSettings = { ...DEFAULT_SETTINGS, voices: { en: "ashley-en" } };
      renderSettings("/settings/voices");
      const preview = await screen.findByRole("button", { name: "Preview Ashley" });

      fireEvent.click(preview);
      await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
      expect(
        JSON.parse(
          String(vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/voices/preview"))?.[1]?.body),
        ),
      ).toEqual({ voice: "ashley-en" });

      fireEvent.click(preview);
      await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1));
    });

    it("reverts the voice select and shows an inline error when the save fails", async () => {
      putFails = true;
      renderSettings("/settings/voices");
      const en = await screen.findByRole("combobox", { name: "Voice for English" });
      fireEvent.change(en, { target: { value: "ashley-en" } });
      expect(en).toHaveProperty("value", "ashley-en"); // optimistic first

      const voices = await screen.findByRole("region", { name: "Voices" });
      const alert = await within(voices).findByRole("alert");
      expect(alert.textContent).toMatch(/Couldn/);
      await waitFor(() => expect(en).toHaveProperty("value", "")); // back to server default
    });
  });
});
