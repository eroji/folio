import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, RequireAuth } from "./AuthProvider";
import { api } from "../api/client";
import type { User } from "../api/types";

const user: User = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "ada",
  display_name: "Ada Lovelace",
  email: "ada@example.local",
  role: "user",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const expired = () => json(401, { error: { code: "unauthenticated", message: "Authentication required." } });

/** /auth/me answers from `me` (signed in by default); /books from `books`. */
function mockFetch(me: () => Response, books: () => Response = () => json(200, { items: [] })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) return me();
      if (url.includes("/books")) return books();
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function Shelf() {
  return (
    <button type="button" onClick={() => void api.get("/books").catch(() => undefined)}>
      Load books
    </button>
  );
}

function renderApp() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<p>Sign in page</p>} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Shelf />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthProvider session loss", () => {
  it("sends a signed-in user to the login screen on the first 401 from any request", async () => {
    mockFetch(() => json(200, { user, csrf_token: "t" }), expired);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Load books" }));
    expect(await screen.findByText("Sign in page")).toBeTruthy();
  });

  it("re-checks the session when the app comes back to the foreground", async () => {
    let signedIn = true;
    mockFetch(() => (signedIn ? json(200, { user, csrf_token: "t" }) : expired()));
    renderApp();
    await screen.findByRole("button", { name: "Load books" });

    signedIn = false; // e.g. the account was disabled while the app was in the background
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Sign in page")).toBeTruthy();
  });

  it("keeps the user signed in when the foreground re-check fails offline", async () => {
    let online = true;
    mockFetch(() => {
      if (!online) throw new TypeError("Failed to fetch");
      return json(200, { user, csrf_token: "t" });
    });
    renderApp();
    await screen.findByRole("button", { name: "Load books" });
    online = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.queryByText("Sign in page")).toBeNull();
    expect(screen.getByRole("button", { name: "Load books" })).toBeTruthy();
  });
});
