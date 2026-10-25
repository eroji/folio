import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, installPlayerFetch, renderPlayer, stubMedia } from "../test/player";
import { MiniPlayer } from "./MiniPlayer";

function Where() {
  const location = useLocation();
  return <p>{location.pathname}</p>;
}

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

async function loadMini(): Promise<() => import("../player/usePlayer").PlayerContextValue> {
  const getPlayer = renderPlayer(
    <>
      <MiniPlayer />
      <Where />
    </>,
    ["/"],
  );
  await act(async () => {
    await getPlayer().load(BOOK_ID);
  });
  return getPlayer;
}

describe("MiniPlayer", () => {
  it("shows above the bottom nav while a book is loaded", async () => {
    const getPlayer = renderPlayer(<MiniPlayer />);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    await act(async () => {
      await getPlayer().load(BOOK_ID);
    });
    const mini = await screen.findByRole("region", { name: "Now playing" });
    expect(mini.textContent).toContain("Chapter One");
    expect(mini.textContent).toContain("Dune");
  });

  it("tapping the cover or titles opens the phone player", async () => {
    await loadMini();
    const link = screen.getByRole("link", { name: "Open player: Chapter One, Dune" });
    expect(link.getAttribute("href")).toBe("/player");
    fireEvent.click(link);
    await screen.findByText("/player");
  });

  it("back 15 and play/pause drive the provider", async () => {
    const getPlayer = await loadMini();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(getPlayer().playing).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
    await waitFor(() => expect(getPlayer().chapterElapsed).toBe(0));
  });
});
