import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

/** Fake matchMedia; the returned setter flips prefers-color-scheme live. */
function stubMedia(initial: boolean): (dark: boolean) => void {
  let dark = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, cb: () => void) => void listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => void listeners.delete(cb),
  }));
  return (next) => {
    dark = next;
    act(() => listeners.forEach((cb) => cb()));
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("useTheme", () => {
  it("resolves system through prefers-color-scheme without persisting it", () => {
    stubMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("folio-theme")).toBeNull();
  });

  it("pins explicit choices, follows the media query for system, live", () => {
    const setDark = stubMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.select("light"));
    expect(localStorage.getItem("folio-theme")).toBe("light");
    setDark(true);
    expect(document.documentElement.dataset.theme).toBe("light"); // pinned: media ignored

    act(() => result.current.select("system"));
    expect(localStorage.getItem("folio-theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("dark"); // follows media

    setDark(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
