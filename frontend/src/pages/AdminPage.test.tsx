import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage";
import type { Job } from "../api/types";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "7",
    type: "ingest",
    book_id: "11111111-1111-1111-1111-111111111111",
    book_title: "Dune",
    user_name: "Browser User",
    user_username: "browser",
    priority: 0,
    status: "failed",
    attempts: 3,
    error: "TTS timeout",
    created_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

let jobs: Job[] = [];
let retryFails = false;
let clearFails = false;
let cache = { files: 1234, bytes: 1288490188, tts: { status: "ok", latency_ms: 42 } };

interface VoiceRowData {
  id: string;
  language: string | null;
  display_name: string | null;
  is_default?: boolean;
  books_count: number;
  on_server: boolean;
  language_overridden?: boolean;
  instructions?: string;
}

let voices: { defaults: Record<string, string>; items: VoiceRowData[]; style_prompts?: boolean } = { defaults: {}, items: [] };
let patchFails = false;
let deleteFails = false;

function resetVoices(): void {
  voices = {
    defaults: { en: "ashley-en", ja: "haruto-ja", ko: "suri-ko" },
    items: [
      { id: "ashley-en", language: "en", display_name: "Ashley", is_default: true, books_count: 74, on_server: true, instructions: "Warm, and unhurried." },
      { id: "marcus-en", language: "en", display_name: "Marcus", books_count: 9, on_server: true },
      { id: "nora-en", language: "en", display_name: null, books_count: 0, on_server: true },
      { id: "narrator-02", language: "en", display_name: "Ruth", books_count: 0, on_server: true, language_overridden: true },
      { id: "haruto-ja", language: "ja", display_name: "Haruto", is_default: true, books_count: 12, on_server: true },
      { id: "suri-ko", language: "ko", display_name: "Suri", is_default: true, books_count: 5, on_server: true },
      { id: "mei-zh", language: "zh", display_name: "Mei", books_count: 0, on_server: true },
      { id: "narrator-01", language: null, display_name: null, books_count: 0, on_server: true },
      { id: "ashley-fr", language: "fr", display_name: "Ashley", books_count: 1, on_server: false },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function findCall(fragment: string, method: string): readonly unknown[] | undefined {
  return vi
    .mocked(fetch)
    .mock.calls.find(([url, init]) => String(url).includes(fragment) && (init?.method ?? "GET") === method);
}

function lastCall(fragment: string, method: string): readonly unknown[] | undefined {
  return [...vi.mocked(fetch).mock.calls]
    .reverse()
    .find(([url, init]) => String(url).includes(fragment) && (init?.method ?? "GET") === method);
}

function bodyOf(call: readonly unknown[] | undefined): Record<string, unknown> {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  jobs = [makeJob(), makeJob({ id: "8", status: "done", error: null })];
  retryFails = false;
  clearFails = false;
  cache = { files: 1234, bytes: 1288490188, tts: { status: "ok", latency_ms: 42 } };
  resetVoices();
  patchFails = false;
  deleteFails = false;
  URL.createObjectURL = vi.fn(() => "blob:sample") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/admin/integrations")) {
        return jsonResponse(200, {
          google_books: { key_set: false, key_hint: null, env_key: false },
          language_model: { base_url: "", model: "", ocr_model: "", ocr: false, suggest: false, thinking: false, key_set: false, key_hint: null },
          style_prompts: true,
          tts: {
            base_url: "",
            env_base_url: "http://tts.example.local/v1",
            key_set: false,
            key_hint: null,
            concurrency: null,
            env_concurrency: 4,
            sentence_requests: null,
            env_request_chars: 0,
            source: "env",
          },
        });
      }
      if (url.includes("/voices/preview")) {
        return { ok: true, status: 200, blob: async () => new Blob(["opus-bytes"]) } as Response;
      }
      if (url.includes("/admin/voices/style-prompts") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean };
        voices.style_prompts = body.enabled;
        return jsonResponse(200, { style_prompts: body.enabled });
      }
      if (url.includes("/admin/voices/defaults") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { language: string; voice_id: string };
        voices.defaults = { ...voices.defaults, [body.language]: body.voice_id };
        return jsonResponse(200, { defaults: voices.defaults });
      }
      const voicePath = url.match(/\/admin\/voices\/([^?]+)$/);
      if (voicePath && method === "PATCH") {
        if (patchFails) return jsonResponse(500, { error: { code: "server_error", message: "nope" } });
        const body = JSON.parse(String(init?.body)) as Record<string, string | null>;
        const item = voices.items.find((i) => i.id === decodeURIComponent(voicePath[1]!));
        if (item) {
          if ("display_name" in body) item.display_name = body.display_name || null;
          if ("language_override" in body) {
            item.language = body.language_override;
            item.language_overridden = body.language_override != null;
          }
          if ("instructions" in body) item.instructions = body.instructions ?? undefined;
        }
        return jsonResponse(200, { item });
      }
      if (voicePath && method === "DELETE") {
        if (deleteFails) return jsonResponse(500, { error: { code: "server_error", message: "nope" } });
        voices.items = voices.items.filter((i) => i.id !== decodeURIComponent(voicePath[1]!));
        return new Response(null, { status: 204 });
      }
      if (url.includes("/voices")) return jsonResponse(200, voices);
      const retry = url.match(/\/admin\/jobs\/([^/]+)\/retry$/);
      if (retry && method === "POST") {
        if (retryFails) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
        jobs = jobs.map((job) => (job.id === retry[1] ? { ...job, status: "queued", error: null } : job));
        return jsonResponse(202, { job: jobs.find((job) => job.id === retry[1]) });
      }
      if (url.includes("/admin/cache/clear") && method === "POST") {
        if (clearFails) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
        cache = { ...cache, files: 0, bytes: 0 };
        return jsonResponse(200, { removed_files: 1234, freed_bytes: 1288490188 });
      }
      if (url.includes("/admin/cache")) return jsonResponse(200, cache);
      if (url.includes("/admin/jobs")) return jsonResponse(200, { items: jobs });
      if (url.includes("/admin/users")) {
        return jsonResponse(200, {
          items: [{ id: "u1", username: "admin", display_name: "Admin User", email: null, role: "admin" }],
        });
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

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openSection(label: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: label }));
  return screen.getByRole("tabpanel");
}

async function openVoices(): Promise<HTMLElement> {
  const panel = await openSection("Voices");
  await within(panel).findByRole("radiogroup", { name: "English voices" });
  return panel;
}

describe("AdminPage", () => {
  it("renders only the selected section, Jobs by default", async () => {
    renderAdmin();
    expect((await screen.findByRole("tab", { name: "Jobs" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Cache" }).getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByRole("button", { name: "Retry job 7" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear cache" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Users" })).toBeNull();
    expect(screen.queryAllByLabelText(/^Display name for /)).toHaveLength(0);
  });

  it("switching tabs swaps the sections", async () => {
    renderAdmin();
    await screen.findByRole("button", { name: "Retry job 7" });

    const panel = await openSection("Voices");
    expect(await within(panel).findByRole("heading", { name: "Voices" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry job 7" })).toBeNull();

    await openSection("Jobs");
    expect(await screen.findByRole("button", { name: "Retry job 7" })).toBeTruthy();
    expect(screen.queryAllByLabelText(/^Display name for /)).toHaveLength(0);
  });

  it("has no old Voice names section", async () => {
    renderAdmin();
    expect(screen.queryByRole("tab", { name: "Voice names" })).toBeNull();
    const panel = await openSection("Voices");
    expect(within(panel).queryByText("Voice names")).toBeNull();
  });

  it("arrow keys and Home/End move selection and focus between the tabs", async () => {
    renderAdmin();
    const jobsTab = await screen.findByRole("tab", { name: "Jobs" });
    fireEvent.keyDown(jobsTab, { key: "ArrowDown" });
    const cacheTab = screen.getByRole("tab", { name: "Cache" });
    expect(cacheTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(cacheTab);
    expect(await screen.findByRole("button", { name: "Clear cache" })).toBeTruthy();

    fireEvent.keyDown(cacheTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Users" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Users" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "Users" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Cache" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Cache" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "AI" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "AI" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "AI" }), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Jobs" }));
  });

  it("uses the Settings layout container and section-title heading scale", () => {
    renderAdmin();
    const heading = screen.getByRole("heading", { name: "Admin", level: 1 });
    expect(heading.className).toContain("text-3xl");
    expect(String(heading.parentElement?.className)).toContain("pt-6");
    const grid = screen.getByRole("tablist").parentElement;
    expect(String(grid?.className)).toContain("flex-wrap items-start gap-8 lg:gap-12");
    expect(String(screen.getByRole("tablist").className)).toContain("lg:w-52");
    expect(String(screen.getByRole("tabpanel").className)).toContain("lg:max-w-[760px]");
  });

  it("renders section panels flat on the page background like Settings", async () => {
    const expectFlat = (el: Element | null | undefined) => {
      const cls = String(el?.className ?? "");
      expect(cls).not.toContain("bg-surface");
      expect(cls).not.toMatch(/(^|\s)rounded-/);
      expect(cls).not.toContain("border border-border");
    };
    renderAdmin();
    const panel = await openSection("Jobs");
    await within(panel).findByRole("button", { name: "Retry job 7" });
    expectFlat(panel.querySelector("table")?.parentElement);

    await openSection("Cache");
    expectFlat((await within(panel).findByText(/1,234 files/)).parentElement);

    await openSection("Users");
    expectFlat(await within(panel).findByRole("list"));

    await openVoices();
    expectFlat(within(panel).getByRole("radiogroup", { name: "English voices" }));
  });

  it("renders cache size and TTS status with latency", async () => {
    renderAdmin();
    const panel = await openSection("Cache");
    expect(await within(panel).findByText(/1,234 files · 1\.2 GiB/)).toBeTruthy();
    expect(within(panel).getByText(/TTS:/)).toBeTruthy();
    expect(within(panel).getByText(/42 ms/)).toBeTruthy();
  });

  it("shows the book title and a human status instead of raw ids", async () => {
    renderAdmin();
    const links = await screen.findAllByRole("link", { name: "Dune" });
    expect(links[0]!.getAttribute("href")).toBe("/books/11111111-1111-1111-1111-111111111111");
    expect(screen.queryByText("11111111-1111-1111-1111-111111111111")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getAllByText(/^Ingest/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Browser User").length).toBe(2);
    expect(screen.getByText(/2 jobs/)).toBeTruthy();
    expect(screen.getByText(/1 failed/)).toBeTruthy();
  });

  it("shows Retry only on failed jobs and requeues with POST", async () => {
    renderAdmin();
    const retryButton = await screen.findByRole("button", { name: "Retry job 7" });
    expect(screen.queryByRole("button", { name: "Retry job 8" })).toBeNull();

    fireEvent.click(retryButton);
    await vi.waitFor(() => {
      expect(findCall("/admin/jobs/7/retry", "POST")).toBeTruthy();
    });
    // Optimistic refresh: the refetched row shows the new status.
    expect(await screen.findByText("Queued")).toBeTruthy();
  });

  it("shows an inline error when retry fails", async () => {
    retryFails = true;
    renderAdmin();
    fireEvent.click(await screen.findByRole("button", { name: "Retry job 7" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t retry this job/);
  });

  it("clears the cache and refreshes the stats", async () => {
    renderAdmin();
    const panel = await openSection("Cache");
    fireEvent.click(await within(panel).findByRole("button", { name: "Clear cache" }));
    await vi.waitFor(() => {
      expect(findCall("/admin/cache/clear", "POST")).toBeTruthy();
    });
    expect(await within(panel).findByText(/0 files · 0 B/)).toBeTruthy();
  });

  it("shows an inline error when the cache clear fails", async () => {
    clearFails = true;
    renderAdmin();
    const panel = await openSection("Cache");
    fireEvent.click(await within(panel).findByRole("button", { name: "Clear cache" }));
    expect(await within(panel).findByRole("alert")).toBeTruthy();
  });

  it("shows the empty state when there are no jobs", async () => {
    jobs = [];
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeTruthy();
  });

  it("lists users read-only", async () => {
    renderAdmin();
    const panel = await openSection("Users");
    const section = await within(panel).findByRole("region", { name: "Users" });
    expect(await within(section).findByText("Admin User")).toBeTruthy();
    expect(within(section).getAllByText("admin").length).toBe(2); // username + role badge
    expect(within(section).queryByRole("button")).toBeNull();
  });
});

describe("AdminPage voices section", () => {
  it("groups voices: languages with books first, then alphabetical, Unassigned, No longer", async () => {
    renderAdmin();
    const panel = await openVoices();
    await within(panel).findByRole("heading", { name: "TTS server" }); // the pane comes first
    const headings = within(panel)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent ?? "");
    expect(headings.map((h) => h.replace(/(en|ja|ko|zh)$/, ""))).toEqual([
      "TTS server",
      "English",
      "Japanese",
      "Korean",
      "Chinese",
      "Unassigned",
      "No longer on the server",
    ]);
    expect(within(panel).getByText("4 voices")).toBeTruthy(); // English
    expect(within(panel).getByText(/Language couldn’t be detected · 1 voice/)).toBeTruthy();
    expect(within(panel).getByText(/8 voices on the server, checked .* ago\./)).toBeTruthy();
  });

  it("shows usage descriptions and the Unassign pill only on manual assignments", async () => {
    renderAdmin();
    const panel = await openVoices();
    expect(await within(panel).findByText("Used by 74 books")).toBeTruthy();
    expect(within(panel).getAllByText("Not used yet").length).toBeGreaterThan(0);
    expect(within(panel).getByRole("button", { name: "Unassign narrator-02" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Unassign ashley-en" })).toBeNull();
    expect(
      within(panel).getByText("Not on the TTS server · 1 book falls back to its language default"),
    ).toBeTruthy();
  });

  it("marks exactly one default per language group", async () => {
    renderAdmin();
    const panel = await openVoices();
    const english = within(within(panel).getByRole("radiogroup", { name: "English voices" }));
    expect(english.getByRole("radio", { name: "Default English voice" }).getAttribute("aria-checked")).toBe("true");
    expect(
      english.getByRole("radio", { name: "Make marcus-en the default English voice" }).getAttribute("aria-checked"),
    ).toBe("false");
    const japanese = within(within(panel).getByRole("radiogroup", { name: "Japanese voices" }));
    expect(japanese.getByRole("radio", { name: "Default Japanese voice" })).toBeTruthy();
  });

  it("switches the default on click with PUT /admin/voices/defaults", async () => {
    renderAdmin();
    const panel = await openVoices();
    const english = within(within(panel).getByRole("radiogroup", { name: "English voices" }));
    fireEvent.click(english.getByRole("radio", { name: "Make marcus-en the default English voice" }));
    await vi.waitFor(() => {
      const call = findCall("/admin/voices/defaults", "PUT");
      expect(call).toBeTruthy();
      expect(bodyOf(call)).toEqual({ language: "en", voice_id: "marcus-en" });
    });
    await vi.waitFor(() => {
      expect(
        english.getByRole("radio", { name: "Make ashley-en the default English voice" }).getAttribute("aria-checked"),
      ).toBe("false");
      expect(english.getByRole("radio", { name: "Default English voice" })).toBeTruthy();
    });
  });

  it("saves the display name on blur and on Enter", async () => {
    renderAdmin();
    const panel = await openVoices();
    const ashley = await within(panel).findByLabelText("Display name for ashley-en");
    fireEvent.change(ashley, { target: { value: "Ash" } });
    fireEvent.blur(ashley);
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/ashley-en", "PATCH"))).toEqual({ display_name: "Ash" });
    });

    const mei = within(panel).getByLabelText("Display name for mei-zh");
    fireEvent.change(mei, { target: { value: "Meiling" } });
    fireEvent.keyDown(mei, { key: "Enter" });
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/mei-zh", "PATCH"))).toEqual({ display_name: "Meiling" });
    });
  });

  it("does not save when the name is unchanged on blur", async () => {
    renderAdmin();
    const panel = await openVoices();
    const ashley = await within(panel).findByLabelText("Display name for ashley-en");
    fireEvent.blur(ashley);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(findCall("/admin/voices/ashley-en", "PATCH")).toBeUndefined();
  });

  async function instructionsPill(panel: HTMLElement, id: string): Promise<HTMLButtonElement> {
    return (await within(panel).findByRole("button", {
      name: `Speaking instructions for ${id}`,
    })) as HTMLButtonElement;
  }

  async function openInstructionsEditor(panel: HTMLElement, id: string, fieldLabel: string): Promise<HTMLTextAreaElement> {
    fireEvent.click(await instructionsPill(panel, id));
    return (await within(panel).findByLabelText(fieldLabel)) as HTMLTextAreaElement;
  }

  function rowOf(panel: HTMLElement, id: string): HTMLElement {
    return within(panel).getByText(id).closest(".border-t") as HTMLElement;
  }

  it("shows no textareas and one truncated italic instruction line per assigned row", async () => {
    renderAdmin();
    const panel = await openVoices();
    expect(panel.querySelectorAll("textarea")).toHaveLength(0);
    const line = within(rowOf(panel, "ashley-en")).getByText("Warm, and unhurried.");
    expect(line.className).toContain("truncate");
    expect(line.className).toContain("italic");
    // Assigned voices without instructions say so; there are six of them.
    expect(within(panel).getAllByText("No speaking instructions")).toHaveLength(6);
    // Removed and unassigned rows show no instruction line at all.
    expect(within(rowOf(panel, "ashley-fr")).queryByText(/speaking instructions/i)).toBeNull();
    expect(within(rowOf(panel, "narrator-01")).queryByText(/speaking instructions/i)).toBeNull();
  });

  it("has no Instructions pill on unassigned or removed rows", async () => {
    renderAdmin();
    const panel = await openVoices();
    await within(panel).findByText("Used by 74 books");
    expect(within(panel).queryByRole("button", { name: "Speaking instructions for narrator-01" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Speaking instructions for ashley-fr" })).toBeNull();
  });

  it("opens one editor at a time and reflects it on the pills' aria-expanded", async () => {
    renderAdmin();
    const panel = await openVoices();
    const ashleyPill = await instructionsPill(panel, "ashley-en");
    fireEvent.click(ashleyPill);
    const ashleyField = (await within(panel).findByLabelText("Speaking instructions for Ashley")) as HTMLTextAreaElement;
    expect(ashleyField.value).toBe("Warm, and unhurried.");
    expect(ashleyPill.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(await instructionsPill(panel, "marcus-en"));
    await vi.waitFor(() => {
      expect(within(panel).queryByLabelText("Speaking instructions for Ashley")).toBeNull();
      expect(panel.querySelectorAll("textarea")).toHaveLength(1);
      expect(within(panel).getByLabelText("Speaking instructions for Marcus")).toBeTruthy();
    });
    expect(ashleyPill.getAttribute("aria-expanded")).toBe("false");
    expect((await instructionsPill(panel, "marcus-en")).getAttribute("aria-expanded")).toBe("true");

    // Pressing the open pill again closes its editor.
    fireEvent.click(await instructionsPill(panel, "marcus-en"));
    await vi.waitFor(() => expect(panel.querySelectorAll("textarea")).toHaveLength(0));
  });

  it("shows the draft character count against 1000", async () => {
    renderAdmin();
    const panel = await openVoices();
    const field = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    expect(within(panel).getByText(/Sent to the TTS server with every request for this voice · 20 \/ 1000/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "Brisk and dry." } });
    expect(within(panel).getByText(/· 14 \/ 1000/)).toBeTruthy();
  });

  it("Save patches the instructions and closes the editor; empty clears", async () => {
    renderAdmin();
    const panel = await openVoices();
    const field = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    fireEvent.change(field, { target: { value: "Brisk and dry." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/ashley-en", "PATCH"))).toEqual({ instructions: "Brisk and dry." });
    });
    await vi.waitFor(() => {
      expect(within(panel).queryByLabelText("Speaking instructions for Ashley")).toBeNull();
      expect(within(rowOf(panel, "ashley-en")).getByText("Brisk and dry.")).toBeTruthy();
    });

    const mei = await openInstructionsEditor(panel, "mei-zh", "Speaking instructions for Mei");
    fireEvent.change(mei, { target: { value: "   " } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/mei-zh", "PATCH"))).toEqual({ instructions: "" });
    });
  });

  it("Cancel closes the editor without saving and discards the draft", async () => {
    renderAdmin();
    const panel = await openVoices();
    const field = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    fireEvent.change(field, { target: { value: "Discard me" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(within(panel).queryByLabelText("Speaking instructions for Ashley")).toBeNull());
    expect(findCall("/admin/voices/ashley-en", "PATCH")).toBeUndefined();

    // Reopening starts from the saved value again.
    const again = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    expect(again.value).toBe("Warm, and unhurried.");
  });

  it("the editor Preview sends the draft instructions, the row Preview the saved ones", async () => {
    renderAdmin();
    const panel = await openVoices();
    const field = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    fireEvent.change(field, { target: { value: "Brisk and dry." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Preview" }));
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/voices/preview", "POST"))).toEqual({ voice: "ashley-en", instructions: "Brisk and dry." });
    });
    // The row's own Preview uses the saved instructions.
    fireEvent.click(within(panel).getByRole("button", { name: "Preview ashley-en" }));
    await vi.waitFor(() => {
      expect(bodyOf(lastCall("/voices/preview", "POST"))).toEqual({ voice: "ashley-en", instructions: "Warm, and unhurried." });
    });
  });

  it("keeps the editor open with an error when the save fails", async () => {
    patchFails = true;
    renderAdmin();
    const panel = await openVoices();
    const field = await openInstructionsEditor(panel, "ashley-en", "Speaking instructions for Ashley");
    fireEvent.change(field, { target: { value: "Nope" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    const alert = await within(rowOf(panel, "ashley-en")).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t save/);
    expect((within(panel).getByLabelText("Speaking instructions for Ashley") as HTMLTextAreaElement).value).toBe("Nope");
  });

  it("assigning a language moves the row out of Unassigned immediately", async () => {
    renderAdmin();
    const panel = await openVoices();
    const select = await within(panel).findByLabelText("Language for narrator-01");
    fireEvent.change(select, { target: { value: "en" } });
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/narrator-01", "PATCH"))).toEqual({ language_override: "en" });
    });
    await vi.waitFor(() => {
      expect(within(panel).queryByLabelText("Language for narrator-01")).toBeNull();
      const english = within(within(panel).getByRole("radiogroup", { name: "English voices" }));
      expect(english.getByLabelText("Display name for narrator-01")).toBeTruthy();
      expect(english.getByRole("radio", { name: "Make narrator-01 the default English voice" })).toBeTruthy();
      expect(english.getByRole("button", { name: "Unassign narrator-01" })).toBeTruthy();
    });
  });

  it("unassign returns the row to Unassigned and keeps the display name", async () => {
    renderAdmin();
    const panel = await openVoices();
    fireEvent.click(await within(panel).findByRole("button", { name: "Unassign narrator-02" }));
    await vi.waitFor(() => {
      expect(bodyOf(findCall("/admin/voices/narrator-02", "PATCH"))).toEqual({ language_override: null });
    });
    await vi.waitFor(() => {
      expect(within(panel).getByLabelText("Language for narrator-02")).toBeTruthy();
      expect(within(panel).queryByLabelText("Display name for narrator-02")).toBeNull();
    });
    // Re-assigning shows the kept name again.
    fireEvent.change(within(panel).getByLabelText("Language for narrator-02"), { target: { value: "ja" } });
    await vi.waitFor(() => {
      const japanese = within(within(panel).getByRole("radiogroup", { name: "Japanese voices" }));
      expect((japanese.getByLabelText("Display name for narrator-02") as HTMLInputElement).value).toBe("Ruth");
    });
  });

  it("removes a voice no longer on the server", async () => {
    renderAdmin();
    const panel = await openVoices();
    fireEvent.click(await within(panel).findByRole("button", { name: "Remove ashley-fr" }));
    await vi.waitFor(() => {
      expect(findCall("/admin/voices/ashley-fr", "DELETE")).toBeTruthy();
    });
    await vi.waitFor(() => {
      expect(within(panel).queryByText("No longer on the server")).toBeNull();
      expect(within(panel).queryByText("ashley-fr")).toBeNull();
    });
  });

  it("has no name field or default control on Unassigned rows", async () => {
    renderAdmin();
    const panel = await openVoices();
    expect(await within(panel).findByText("Assign a language to name it and offer it to listeners")).toBeTruthy();
    expect(within(panel).queryByLabelText("Display name for narrator-01")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Preview narrator-01" })).toBeTruthy();
  });

  it("preview plays a sample and the same button stops it", async () => {
    renderAdmin();
    const panel = await openVoices();
    const preview = await within(panel).findByRole("button", { name: "Preview marcus-en" });
    fireEvent.click(preview);
    await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
    expect(bodyOf(findCall("/voices/preview", "POST"))).toEqual({ voice: "marcus-en" });
    fireEvent.click(preview);
    await vi.waitFor(() => expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1));
  });

  it("switches style prompts from the Voices pane, and drops the language-detection paragraph", async () => {
    voices.style_prompts = false;
    renderAdmin();
    const panel = await openVoices();
    expect(within(panel).queryByText(/language is detected automatically/)).toBeNull();
    const toggle = await within(panel).findByRole("switch", { name: "Send style prompts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(bodyOf(lastCall("/admin/voices/style-prompts", "PUT"))).toEqual({ enabled: true }));
    await waitFor(() =>
      expect(within(panel).getByRole("switch", { name: "Send style prompts" }).getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("refreshes the voices from the header button", async () => {
    renderAdmin();
    const panel = await openVoices();
    fireEvent.click(await within(panel).findByRole("button", { name: "Refresh voices" }));
    await vi.waitFor(() => {
      expect(findCall("/voices?refresh=true", "GET")).toBeTruthy();
    });
  });

  it("shows an error under the row when a save fails", async () => {
    patchFails = true;
    renderAdmin();
    const panel = await openVoices();
    const ashley = await within(panel).findByLabelText("Display name for ashley-en");
    fireEvent.change(ashley, { target: { value: "Ash" } });
    fireEvent.blur(ashley);
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn.t save/);
  });

  it("shows the empty state when the server lists no voices", async () => {
    voices = { defaults: {}, items: [] };
    renderAdmin();
    const panel = await openSection("Voices");
    expect(await within(panel).findByRole("heading", { name: "No voices found" })).toBeTruthy();
  });
});
