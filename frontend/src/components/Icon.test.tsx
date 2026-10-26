import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders at the requested size", () => {
    const { container } = render(<Icon name="Play" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });

  it("draws the transport icons filled and everything else stroked", () => {
    const { container } = render(
      <div>
        <Icon name="Play" />
        <Icon name="X" />
      </div>,
    );
    const play = container.querySelectorAll("svg")[0]!;
    const close = container.querySelectorAll("svg")[1]!;
    expect(play.getAttribute("fill")).toBe("currentColor");
    expect(play.getAttribute("stroke-width")).toBe("0");
    expect(close.getAttribute("stroke-width")).toBe("2");
  });

  it("is decorative without a label and named with one", () => {
    const { container } = render(<Icon name="X" label="Close" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Close");
    expect(svg.getAttribute("role")).toBe("img");
  });
});
