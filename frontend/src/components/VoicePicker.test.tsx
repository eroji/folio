import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoicePicker } from "./VoicePicker";

const VOICES = {
  items: [
    { id: "ashley-en", language: "en", description: null, available: true },
    { id: "ashley-ja", language: "ja", description: null, available: true },
    { id: "ashley-old", language: "en", description: null, available: false },
    { id: "tts", language: null, description: "engine default", available: true },
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
  it("lists the language's voices plus any-language voices until Show all is checked", async () => {
    renderPicker(<VoicePicker value={null} language="en" onChange={() => undefined} />);
    expect(await screen.findByRole("option", { name: "ashley-en" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "tts — engine default" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "ashley-ja" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Show all voices/ }));
    expect(await screen.findByRole("option", { name: "ashley-ja" })).toBeTruthy();
  });

  it("marks the saved voice No longer available when it is absent from the engine", async () => {
    renderPicker(<VoicePicker value="ghost-voice" language="en" onChange={() => undefined} />);
    const note = await screen.findByText(/is no longer available/i);
    const select = screen.getByRole("combobox", { name: "en voice" });
    expect((select as HTMLSelectElement).value).toBe("ghost-voice");
    expect(note).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
  });

  it("marks an engine voice that turned unavailable", async () => {
    renderPicker(<VoicePicker value="ashley-old" language="en" onChange={() => undefined} />);
    await vi.waitFor(() => {
      const option = screen.getByRole("option", { name: /ashley-old/ });
      expect(option.textContent).toMatch(/No longer available/);
      expect(option.hasAttribute("disabled")).toBe(true);
    });
  });

  it("previews the selected voice and revokes the previous object URL", async () => {
    const onChange = vi.fn();
    renderPicker(<VoicePicker value="ashley-en" language="en" onChange={onChange} />);
    await screen.findByRole("combobox", { name: "en voice" });

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

  it("calls onChange with null when Default is picked", async () => {
    const onChange = vi.fn();
    renderPicker(<VoicePicker value="ashley-en" language="en" onChange={onChange} />);
    const select = await screen.findByRole("combobox", { name: "en voice" });
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
