import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage";
import type { Job } from "../api/types";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 7,
    type: "ingest",
    book_id: "11111111-1111-1111-1111-111111111111",
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

const derivedNames: Record<string, string> = { "ashley-en": "Ashley", "ashley-ja": "Ashley (JA)" };
let voiceNames: { names: Record<string, string>; items: { id: string; display_name: string; overridden: boolean }[] } = {
  names: { "ashley-ja": "Yuki" },
  items: [
    { id: "ashley-en", display_name: "Ashley", overridden: false },
    { id: "ashley-ja", display_name: "Yuki", overridden: true },
  ],
};

function applyVoiceNames(names: Record<string, string>) {
  voiceNames = {
    names,
    items: Object.keys(derivedNames).map((id) => ({
      id,
      display_name: names[id] ?? derivedNames[id]!,
      overridden: id in names,
    })),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  jobs = [makeJob(), makeJob({ id: 8, status: "done", error: null })];
  retryFails = false;
  clearFails = false;
  cache = { files: 1234, bytes: 1288490188, tts: { status: "ok", latency_ms: 42 } };
  applyVoiceNames({ "ashley-ja": "Yuki" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/admin/voice-names") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { names: Record<string, string> };
        applyVoiceNames(body.names);
        return jsonResponse(200, { names: body.names });
      }
      if (url.includes("/admin/voice-names")) return jsonResponse(200, voiceNames);
      const retry = url.match(/\/admin\/jobs\/(\d+)\/retry$/);
      if (retry && method === "POST") {
        if (retryFails) return jsonResponse(500, { error: { code: "nope", message: "nope" } });
        jobs = jobs.map((job) => (job.id === Number(retry[1]) ? { ...job, status: "queued", error: null } : job));
        return jsonResponse(202, { job: jobs.find((job) => job.id === Number(retry[1])) });
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

async function openSection(label: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: label }));
  return screen.getByRole("tabpanel");
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

    await openSection("Voice names");
    expect(await screen.findByLabelText("Display name for ashley-en")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry job 7" })).toBeNull();

    await openSection("Jobs");
    expect(await screen.findByRole("button", { name: "Retry job 7" })).toBeTruthy();
    expect(screen.queryAllByLabelText(/^Display name for /)).toHaveLength(0);
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
    expect(screen.getByRole("tab", { name: "Voice names" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Voice names" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "Voice names" }), { key: "Home" });
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

    await openSection("Voice names");
    for (const list of await within(panel).findAllByRole("list")) expectFlat(list);
  });

  it("renders cache size and TTS status with latency", async () => {
    renderAdmin();
    const panel = await openSection("Cache");
    expect(await within(panel).findByText(/1,234 files · 1\.2 GiB/)).toBeTruthy();
    expect(within(panel).getByText(/TTS:/)).toBeTruthy();
    expect(within(panel).getByText(/42 ms/)).toBeTruthy();
  });

  it("shows Retry only on failed jobs and requeues with POST", async () => {
    renderAdmin();
    const retryButton = await screen.findByRole("button", { name: "Retry job 7" });
    expect(screen.queryByRole("button", { name: "Retry job 8" })).toBeNull();

    fireEvent.click(retryButton);
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes("/admin/jobs/7/retry") && init?.method === "POST");
      expect(call).toBeTruthy();
    });
    // Optimistic refresh: the refetched row shows the new status.
    expect(await screen.findByText("queued")).toBeTruthy();
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
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes("/admin/cache/clear") && init?.method === "POST");
      expect(call).toBeTruthy();
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

  it("prefills voice names with the effective name and flags overrides", async () => {
    renderAdmin();
    const panel = await openSection("Voice names");
    const section = await within(panel).findByRole("region", { name: "Voice names" });
    expect((await within(section).findByLabelText("Display name for ashley-en") as HTMLInputElement).value).toBe(
      "Ashley",
    );
    expect((within(section).getByLabelText("Display name for ashley-ja") as HTMLInputElement).value).toBe("Yuki");
    expect(within(section).getAllByText("Custom")).toHaveLength(1);
  });

  it("saves edited and untouched overrides and shows the saved indicator", async () => {
    renderAdmin();
    const panel = await openSection("Voice names");
    const section = await within(panel).findByRole("region", { name: "Voice names" });
    fireEvent.change(await within(section).findByLabelText("Display name for ashley-en"), {
      target: { value: "Ash" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes("/admin/voice-names") && init?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toEqual({ names: { "ashley-en": "Ash", "ashley-ja": "Yuki" } });
    });
    expect(await within(section).findByText("Saved")).toBeTruthy();
    expect(within(section).getAllByText("Custom")).toHaveLength(2);
  });

  it("clearing an override removes it from the saved map", async () => {
    renderAdmin();
    const panel = await openSection("Voice names");
    const section = await within(panel).findByRole("region", { name: "Voice names" });
    fireEvent.change(await within(section).findByLabelText("Display name for ashley-ja"), { target: { value: "" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes("/admin/voice-names") && init?.method === "PUT");
      expect(JSON.parse(String(call![1]!.body))).toEqual({ names: {} });
    });
    await vi.waitFor(() => {
      const ja = within(section).getByLabelText("Display name for ashley-ja") as HTMLInputElement;
      expect(ja.value).toBe("Ashley (JA)");
    });
    expect(within(section).queryByText("Custom")).toBeNull();
  });
});
