import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceLabel, readPosition, rememberPosition, saveProgress, secondsAhead } from "./progress";
import { makeProgress } from "../test/player";
import type { Book } from "./types";

const BOOK = { total_chars: 1200, est_duration_s: 600 } as Book;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("progress helpers", () => {
  it("deviceLabel is stable per browser, readable and at most 64 chars", () => {
    const label = deviceLabel();
    expect(deviceLabel()).toBe(label);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label).toMatch(/[0-9a-f]{4}$/);
  });

  it("remembers and reads back this device's position", () => {
    const id = "b1";
    expect(readPosition(id)).toBeNull();
    rememberPosition(id, makeProgress({ percent: 12.5 }));
    expect(readPosition(id)?.percent).toBe(12.5);
  });

  it("secondsAhead maps the percent gap through the duration estimate", () => {
    expect(secondsAhead(makeProgress({ percent: 20 }), makeProgress({ percent: 10 }), BOOK)).toBeCloseTo(60);
    expect(secondsAhead(makeProgress({ percent: 5 }), makeProgress({ percent: 10 }), BOOK)).toBe(0);
  });

  it("saveProgress sends the CSRF header with keepalive and stays null on failure", async () => {
    document.cookie = "folio_csrf=tok3n";
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response("", { status: 500 });
      }),
    );
    await expect(saveProgress("b1", { chapter_id: "c", segment_id: "s", offset_s: 1, device_label: "d" })).resolves.toBeNull();
    expect(calls[0]).toMatchObject({ method: "PUT", keepalive: true });
    expect((calls[0]?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok3n");
  });
});
