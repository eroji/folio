import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders every symbol 10 % larger than the requested size", () => {
    const { container } = render(<Icon name="play_arrow" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("22");
    expect(svg.getAttribute("height")).toBe("22");
  });

  it("rounds the scaled size for odd values", () => {
    const { container } = render(<Icon name="close" size={16} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("18"); // 16 × 1.1 = 17.6
    expect(svg.getAttribute("height")).toBe("18");
  });
});
