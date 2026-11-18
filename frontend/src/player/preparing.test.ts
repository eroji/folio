import { describe, expect, it } from "vitest";
import { preparingPercent, preparingText } from "./preparing";

describe("preparing progress", () => {
  it("counts sentences once the worker reports them", () => {
    expect(preparingText({ done: 4, total: 11 })).toBe("Preparing audio… 4 of 11 sentences");
    expect(preparingText({ done: 0, total: 11 })).toBe("Preparing audio… 0 of 11 sentences");
  });

  it("keeps the plain label before a report or for a one-sentence segment", () => {
    expect(preparingText(null)).toBe("Preparing audio…");
    expect(preparingText({ done: 0, total: 1 })).toBe("Preparing audio…");
  });

  it("rounds the share done to a whole percent", () => {
    expect(preparingPercent({ done: 4, total: 11 })).toBe(36);
    expect(preparingPercent({ done: 11, total: 11 })).toBe(100);
    expect(preparingPercent(null)).toBeNull();
  });
});
