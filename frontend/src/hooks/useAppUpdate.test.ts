import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_ID, useAppUpdate } from "./useAppUpdate";

function serveBuild(build: string) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ build }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  sessionStorage.clear();
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAppUpdate", () => {
  it("does nothing while the deployed build is the one running", async () => {
    const fetchMock = serveBuild(BUILD_ID);
    const reload = vi.fn();
    const { result } = renderHook(() => useAppUpdate({ enabled: true, isBusy: () => false, reload }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]).toEqual(["/version.json", { cache: "no-store" }]);
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.outdated).toBe(false);
  });

  it("reloads at once when a newer build is deployed and nothing is playing", async () => {
    serveBuild("newer-build");
    const reload = vi.fn();
    renderHook(() => useAppUpdate({ enabled: true, isBusy: () => false, reload }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem("folio-reloaded-for")).toBe("newer-build");
  });

  it("offers a reload instead of interrupting playback", async () => {
    serveBuild("newer-build");
    const reload = vi.fn();
    const { result } = renderHook(() => useAppUpdate({ enabled: true, isBusy: () => true, reload }));
    await waitFor(() => expect(result.current.outdated).toBe(true));
    expect(reload).not.toHaveBeenCalled();
    act(() => result.current.reload());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads twice for the same build (a stale cache cannot loop)", async () => {
    sessionStorage.setItem("folio-reloaded-for", "newer-build");
    serveBuild("newer-build");
    const reload = vi.fn();
    const { result } = renderHook(() => useAppUpdate({ enabled: true, isBusy: () => false, reload }));
    await waitFor(() => expect(result.current.outdated).toBe(true));
    expect(reload).not.toHaveBeenCalled();
  });

  it("checks again when a resumed app becomes visible, at most once a minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = serveBuild(BUILD_ID);
    const reload = vi.fn();
    renderHook(() => useAppUpdate({ enabled: true, isBusy: () => false, reload }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setVisibility("hidden");
    setVisibility("visible"); // back within the minute: no new request
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    serveBuild("newer-build");
    setVisibility("hidden");
    setVisibility("visible");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("ignores a failed or malformed version check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    const reload = vi.fn();
    const { result } = renderHook(() => useAppUpdate({ enabled: true, isBusy: () => false, reload }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.outdated).toBe(false);
  });

  it("is off in development", async () => {
    const fetchMock = serveBuild("newer-build");
    renderHook(() => useAppUpdate({ enabled: false, isBusy: () => false, reload: vi.fn() }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
