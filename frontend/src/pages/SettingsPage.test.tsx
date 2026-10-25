import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    { id: "ashley-kr", language: "ko", description: null, available: false },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callsTo(fragment: string): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
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

  it("persists the default playback speed", async () => {
    renderSettings();
    fireEvent.change(await screen.findByLabelText("Default playback speed"), {
      target: { value: "1.5" },
    });
    expect(localStorage.getItem("folio-speed")).toBe("1.5");
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
