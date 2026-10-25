import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReadAlong, splitSentences } from "./ReadAlong";

describe("ReadAlong", () => {
  it("splits on sentence-ending punctuation", () => {
    expect(splitSentences("One two. Three four! Five… Six")).toEqual(["One two.", "Three four!", "Five…", "Six"]);
  });

  it("highlights the sentence at the character-share position", () => {
    render(<ReadAlong text="First sentence. Second one! Third." fraction={0.5} />);
    expect(screen.getByText(/Second one/).getAttribute("aria-current")).toBe("true");
    expect(screen.getByText(/First sentence/).getAttribute("aria-current")).toBeNull();
  });

  it("highlights the first sentence at the start", () => {
    render(<ReadAlong text="First sentence. Second one! Third." fraction={0} />);
    expect(screen.getByText(/First sentence/).getAttribute("aria-current")).toBe("true");
  });
});
