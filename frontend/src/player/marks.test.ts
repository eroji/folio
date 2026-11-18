import { describe, expect, it } from "vitest";
import { spokenFraction, timeForFraction, type Marks } from "./marks";

// Sentence 2 starts half-way through the text at 2 s, sentence 3 at 75 % at 5 s.
const MARKS: Marks = [
  [0, 0],
  [0.5, 2],
  [0.75, 5],
];

describe("sentence marks", () => {
  it("interpolates the spoken share of the text within each sentence", () => {
    expect(spokenFraction(1, 6, MARKS)).toBeCloseTo(0.25);
    expect(spokenFraction(2, 6, MARKS)).toBeCloseTo(0.5); // exactly at a sentence start
    expect(spokenFraction(3.5, 6, MARKS)).toBeCloseTo(0.625);
    expect(spokenFraction(5.5, 6, MARKS)).toBeCloseTo(0.875); // last sentence runs to the end
    expect(spokenFraction(9, 6, MARKS)).toBe(1);
    expect(spokenFraction(-1, 6, MARKS)).toBe(0);
  });

  it("maps a place in the text back to the second it is spoken", () => {
    expect(timeForFraction(0.5, 6, MARKS)).toBeCloseTo(2);
    expect(timeForFraction(0.625, 6, MARKS)).toBeCloseTo(3.5);
    expect(timeForFraction(0.875, 6, MARKS)).toBeCloseTo(5.5);
  });

  it("falls back to an even spread without marks", () => {
    expect(spokenFraction(3, 6, null)).toBeCloseTo(0.5);
    expect(timeForFraction(0.5, 6, undefined)).toBeCloseTo(3);
    expect(spokenFraction(3, 0, MARKS)).toBe(0); // no duration yet
  });
});
