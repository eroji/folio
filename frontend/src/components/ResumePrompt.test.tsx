import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResumePrompt } from "./ResumePrompt";

describe("ResumePrompt", () => {
  it("renders the spec copy and fires the chosen action", () => {
    const onContinue = vi.fn();
    const onStartHere = vi.fn();
    render(
      <ResumePrompt device="Linux a1b2" chapter="Chapter Two" time="12:34" onContinue={onContinue} onStartHere={onStartHere} />,
    );
    expect(screen.getByText("Continue from Chapter Two, 12:34 on Linux a1b2?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onStartHere).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start here" }));
    expect(onStartHere).toHaveBeenCalledOnce();
  });
});
