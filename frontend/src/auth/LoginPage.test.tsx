import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthProvider";
import { LoginPage } from "./LoginPage";
import type { User } from "../api/types";

const user: User = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "ada",
  display_name: "Ada Lovelace",
  email: "ada@example.local",
  role: "user",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Boot /auth/me always 401s (guest); login responses come from `login`. */
function mockFetch(login: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return jsonResponse(401, { error: { code: "unauthenticated", message: "Authentication required." } });
      }
      if (url.includes("/auth/login")) return login();
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderLogin(onSuccess = vi.fn()) {
  render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage onSuccess={onSuccess} />
      </AuthProvider>
    </MemoryRouter>,
  );
  return onSuccess;
}

async function submitCredentials() {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  localStorage.clear();
});

describe("LoginPage", () => {
  it("renders the wordmark and the spec copy", () => {
    mockFetch(() => jsonResponse(200, { user, csrf_token: "t" }));
    renderLogin();
    expect(screen.getByAltText("Folio")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in with your directory account" })).toBeTruthy();
  });

  it("shows the server error message inline on bad credentials", async () => {
    mockFetch(() =>
      jsonResponse(401, { error: { code: "invalid_credentials", message: "Invalid username or password" } }),
    );
    renderLogin();
    await submitCredentials();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Invalid username or password");
  });

  it("calls onSuccess with the user on a good login", async () => {
    mockFetch(() => jsonResponse(200, { user, csrf_token: "t" }));
    const onSuccess = renderLogin();
    await submitCredentials();
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith(user));
  });
});
