import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { groupVoicesByLanguage, previewVoice, type Voice } from "./voices";

const voice = (id: string, language: string | null): Voice => ({
  id,
  language,
  description: null,
  available: true,
});

describe("groupVoicesByLanguage", () => {
  it("keys by base language and collects untagged voices under any", () => {
    const groups = groupVoicesByLanguage([
      voice("ashley-en", "en"),
      voice("ashley-kr", "ko"),
      voice("ashley-tw", "zh-TW"),
      voice("tts", null),
    ]);
    expect(Object.keys(groups).sort()).toEqual(["any", "en", "ko", "zh"]);
    expect(groups.zh).toEqual([voice("ashley-tw", "zh-TW")]);
    expect(groups.any).toEqual([voice("tts", null)]);
  });
});

describe("previewVoice", () => {
  const originalCreate = URL.createObjectURL;

  beforeEach(() => {
    document.cookie = "folio_csrf=t0ken";
    URL.createObjectURL = vi.fn(() => "blob:preview");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreate;
    document.cookie = "folio_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("posts the voice with the CSRF header and returns an object URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["opus"]) })),
    );
    await expect(previewVoice("ashley-en")).resolves.toBe("blob:preview");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/voices/preview");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("t0ken");
    expect(init?.body).toBe(JSON.stringify({ voice: "ashley-en" }));
  });

  it("unwraps the error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "voice_unavailable", message: "No." } }),
    })));
    await expect(previewVoice("gone")).rejects.toMatchObject({
      name: "ApiError",
      code: "voice_unavailable",
      status: 404,
    } satisfies Partial<ApiError>);
  });
});
