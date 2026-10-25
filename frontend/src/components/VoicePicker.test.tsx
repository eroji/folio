import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoicePicker } from "./VoicePicker";

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "alex-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    { id: "ashley-tw", language: "zh-TW", description: null, available: true },
    { id: "ashley-old", language: "en", description: null, available: false },
    // Tagged on purpose: the picker must hide "tts" even if the API sends it.
    { id: "tts", language: "en", description: "engine default", available: true },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let objectUrlCount = 0;
const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
  objectUrlCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:sample-${++objectUrlCount}`);
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/voices/preview")) {
        return { ok: true, status: 200, blob: async () => new Blob(["opus-bytes"]) } as Response;
      }
      if (url.includes("/voices")) return jsonResponse(200, VOICES);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = originalUrl.create;
  URL.revokeObjectURL = originalUrl.revoke;
});

function renderPicker(
  ui: React.ReactElement,
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("VoicePicker", () => {
  it("lists only the language's voices and never the tts pseudo-voice", async () => {
    renderPicker(<VoicePicker value={null} language="en" onChange={() => undefined} />);
    expect(await screen.findByRole("option", { name: "ashley-en" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "alex-en" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "ashley-ja" })).toBeNull();
    expect(screen.queryByRole("option", { name: /tts/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull(); // no "Show all voices" toggle
  });

  it("matches zh-TW pickers to zh voices", async () => {
    renderPicker(<VoicePicker value={null} language="zh-TW" onChange={() => undefined} />);
    expect(await screen.findByRole("option", { name: "ashley-tw" })).toBeTruthy();
  });

  it("preselects the first available voice without calling onChange", async () => {
    const onChange = vi.fn();
    renderPicker(<VoicePicker value={null} language="en" onChange={onChange} />);
    const select = await screen.findByRole("combobox", { name: "en voice" });
    await vi.waitFor(() => expect(select).toHaveProperty("value", "ashley-en"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(false);
  });

  it("calls onChange with the explicitly chosen voice", async () => {
    const onChange = vi.fn();
    renderPicker(<VoicePicker value="ashley-en" language="en" onChange={onChange} />);
    const select = await screen.findByRole("combobox", { name: "en voice" });
    await screen.findByRole("option", { name: "alex-en" });
    fireEvent.change(select, { target: { value: "alex-en" } });
    expect(onChange).toHaveBeenCalledWith("alex-en");
  });

  it("notes a saved voice that left the engine and shows the first available instead", async () => {
    renderPicker(<VoicePicker value="ghost-voice" language="en" onChange={() => undefined} />);
    const note = await screen.findByText(/is no longer available/i);
    const select = screen.getByRole("combobox", { name: "en voice" });
    expect(select).toHaveProperty("value", "ashley-en");
    expect(note).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(false);
  });

  it("marks an engine voice that turned unavailable", async () => {
    renderPicker(<VoicePicker value="ashley-old" language="en" onChange={() => undefined} />);
    await vi.waitFor(() => {
      const option = screen.getByRole("option", { name: /ashley-old/ });
      expect(option.textContent).toMatch(/No longer available/);
      expect(option.hasAttribute("disabled")).toBe(true);
    });
    expect(await screen.findByText(/is no longer available/i)).toBeTruthy();
  });

  it("disables the picker and hides Preview when the language has no voices", async () => {
    renderPicker(<VoicePicker value={null} language="ko" onChange={() => undefined} />);
    const select = await screen.findByRole("combobox", { name: "ko voice" });
    await vi.waitFor(() => expect(select.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("No voices available for this language")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("previews the selected voice and revokes the previous object URL", async () => {
    renderPicker(<VoicePicker value={null} language="en" onChange={() => undefined} />);
    await screen.findByRole("combobox", { name: "en voice" });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const preview = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).includes("/voices/preview"));
    expect(preview).toBeTruthy();
    expect(JSON.parse(String(preview?.[1]?.body))).toEqual({ voice: "ashley-en" });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sample-1");
  });
});
