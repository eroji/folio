import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("MiniPlayer", () => {
  it("renders once a book is loaded and opens the full player on tap", async () => {
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

    expect(screen.queryByRole("button", { name: "Open player" })).toBeNull();
    await act(async () => {
      await current!.load(BOOK_ID);
    });

    expect(await screen.findByText("Chapter One")).toBeTruthy();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open player" }));
    expect(await screen.findByText("Full player screen")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open player" })).toBeNull(); // hidden on /player
  });
});
