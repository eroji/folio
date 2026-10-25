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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  jobs = [makeJob(), makeJob({ id: 8, status: "done", error: null })];
  retryFails = false;
  clearFails = false;
  cache = { files: 1234, bytes: 1288490188, tts: { status: "ok", latency_ms: 42 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
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

describe("AdminPage", () => {
  it("renders cache size and TTS status with latency", async () => {
    renderAdmin();
    expect(await screen.findByText(/1,234 files · 1\.2 GiB/)).toBeTruthy();
    expect(screen.getByText(/TTS:/)).toBeTruthy();
    expect(screen.getByText(/42 ms/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));
    await vi.waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url, init]) => String(url).includes("/admin/cache/clear") && init?.method === "POST");
      expect(call).toBeTruthy();
    });
    expect(await screen.findByText(/0 files · 0 B/)).toBeTruthy();
  });

  it("shows an inline error when the cache clear fails", async () => {
    clearFails = true;
    renderAdmin();
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("shows the empty state when there are no jobs", async () => {
    jobs = [];
    renderAdmin();
    expect(await screen.findByRole("heading", { name: "No jobs yet" })).toBeTruthy();
  });

  it("lists users read-only", async () => {
    renderAdmin();
    const section = await screen.findByRole("region", { name: "Users" });
    expect(await within(section).findByText("Admin User")).toBeTruthy();
    expect(within(section).getAllByText("admin").length).toBe(2); // username + role badge
    expect(within(section).queryByRole("button")).toBeNull();
  });
});
