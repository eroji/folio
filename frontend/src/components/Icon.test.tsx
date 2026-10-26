import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomeFilled from "@material-symbols/svg-400/rounded/home-fill.svg?react";
import PauseFilled from "@material-symbols/svg-400/rounded/pause-fill.svg?react";
import PlayFilled from "@material-symbols/svg-400/rounded/play_arrow-fill.svg?react";
import SkipNextFilled from "@material-symbols/svg-400/rounded/skip_next-fill.svg?react";
import SkipPreviousFilled from "@material-symbols/svg-400/rounded/skip_previous-fill.svg?react";
import { Icon, ICON_NAMES, type IconName } from "./Icon";

describe("Icon", () => {
  it("renders at the requested size", () => {
    const { container } = render(<Icon name="Play" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });

  it("renders every icon in currentColor and never default-black SVG fills", () => {
    const { container } = render(
      <>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    );
    expect(container.querySelectorAll("svg").length).toBe(ICON_NAMES.length);
    expect(container.innerHTML).not.toMatch(/fill="black"/i);
    expect(container.innerHTML).not.toMatch(/#000/i);
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("fill")).toBe("currentColor");
    }
  });

  it("draws the transport icons with the filled glyphs and everything else outlined", () => {
    const pathD = (node: HTMLElement) => node.querySelector("path")!.getAttribute("d");
    const filled: [IconName, HTMLElement][] = [
      ["Play", render(<PlayFilled />).container],
      ["Pause", render(<PauseFilled />).container],
      ["SkipBack", render(<SkipPreviousFilled />).container],
      ["SkipForward", render(<SkipNextFilled />).container],
    ];
    for (const [name, glyph] of filled) {
      expect(pathD(render(<Icon name={name} />).container)).toBe(pathD(glyph));
    }
    expect(pathD(render(<Icon name="House" />).container)).not.toBe(pathD(render(<HomeFilled />).container));
  });

  it("is decorative without a label and named with one", () => {
    const { container } = render(<Icon name="X" label="Close" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Close");
    expect(svg.getAttribute("role")).toBe("img");
  });
});
