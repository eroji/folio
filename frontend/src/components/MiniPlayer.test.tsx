import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerContextValue } from "../player/PlayerProvider";
import { PlayerProvider } from "../player/PlayerProvider";
import { usePlayer } from "../player/usePlayer";
import { installMockEventSource } from "../test/eventsource";
import { BOOK_ID, installPlayerFetch, stubMedia } from "../test/player";
import { MiniPlayer } from "./MiniPlayer";

let current: PlayerContextValue | undefined;
function Probe() {
  current = usePlayer();
  return null;
}

beforeEach(() => {
  installMockEventSource();
  installPlayerFetch();
  stubMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAtRoot() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <PlayerProvider>
          <Routes>
            <Route
              path="/"
              element={
                <>
                  <Probe />
                  <MiniPlayer />
                </>
              }
            />
            <Route path="/player" element={<p>Full player screen</p>} />
          </Routes>
        </PlayerProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MiniPlayer", () => {
  it("renders the Plex-style transport, percent badge, and chapter clock", async () => {
    renderAtRoot();
    await act(async () => {
      await current!.load(BOOK_ID);
    });

    for (const name of ["Previous chapter", "Back 15 seconds", "Play", "Forward 30 seconds", "Next chapter", "Stop"]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByTestId("mini-percent").textContent).toBe("0%");
    expect(screen.getByText(/Chapter One · 0:00 \/ 0:20/)).toBeTruthy();
  });

  it("stop clears the book and hides the bar", async () => {
    renderAtRoot();
    await act(async () => {
      await current!.load(BOOK_ID);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(current!.book).toBeNull());
    expect(screen.queryByRole("button", { name: "Open player" })).toBeNull();
  });

  it("renders once a book is loaded and opens the full player on tap", async () => {
    renderAtRoot();

    expect(screen.queryByRole("button", { name: "Open player" })).toBeNull();
    await act(async () => {
      await current!.load(BOOK_ID);
    });

    expect(await screen.findByText(/Chapter One/)).toBeTruthy();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open player" }));
    expect(await screen.findByText("Full player screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open player" })).toBeNull(); // hidden on /player
  });

  it("renders at desktop width and navigates to the player", async () => {
    renderAtRoot();
    await act(async () => {
      await current!.load(BOOK_ID);
    });

    const open = await screen.findByRole("button", { name: "Open player" });
    // jsdom applies no media queries: the guard is that the bar carries no md:hidden.
    const bar = open.closest("div.fixed");
    expect(bar).not.toBeNull();
    expect(bar!.className).not.toContain("md:hidden");

    fireEvent.click(open);
    expect(await screen.findByText("Full player screen")).toBeTruthy();
  });
});
