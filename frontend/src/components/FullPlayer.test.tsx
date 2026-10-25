import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, CH1, installPlayerFetch, renderPlayer, stubMedia } from "../test/player";
import { FullPlayer } from "./FullPlayer";

describe("FullPlayer", () => {
  beforeEach(() => {
    localStorage.clear();
    installMockEventSource();
    installPlayerFetch();
    stubMedia();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderFull() {
    const getPlayer = renderPlayer(<FullPlayer />, [`/player?book=${BOOK_ID}`]);
    await waitFor(() => expect(getPlayer().book).toBeTruthy());
    return getPlayer;
  }

  it("shows the read-along by default and the button toggles it", async () => {
    await renderFull();
    const sentence = new RegExp(`One ${CH1}-seg0 here`);
    // The active sentence appears twice: in the text and the sr-only live region.
    expect((await screen.findAllByText(sentence)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Read along" }));
    await waitFor(() => expect(screen.queryAllByText(sentence)).toHaveLength(0));
    fireEvent.click(screen.getByRole("button", { name: "Read along" }));
    expect((await screen.findAllByText(sentence)).length).toBeGreaterThan(0);
  });

  it("sleep menu lists the choices, marks the active one, and sets it", async () => {
    const getPlayer = await renderFull();
    const trigger = screen.getByRole("button", { name: /^Sleep timer, currently off/ });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Sleep timer" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent?.trim())).toEqual([
      "Off",
      "15 minutes",
      "30 minutes",
      "45 minutes",
      "60 minutes",
      "End of chapter",
    ]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "30 minutes" }));
    await waitFor(() => expect(getPlayer().sleep).toBe(30));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.textContent).toContain("30 min");

    fireEvent.click(trigger);
    const again = screen.getByRole("menu", { name: "Sleep timer" });
    expect(within(again).getByRole("menuitemradio", { name: "30 minutes" }).getAttribute("aria-checked")).toBe("true");
  });
});
