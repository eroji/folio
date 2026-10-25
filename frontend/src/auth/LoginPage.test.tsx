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
function mockFetch(login: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return jsonResponse(401, { error: { code: "unauthenticated", message: "Authentication required." } });
      }
      if (url.includes("/auth/options")) return jsonResponse(200, { test_mode: false });
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
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("renders the mark, the lowercase folio wordmark and autofill-ready fields", () => {
    mockFetch(() => jsonResponse(200, { user, csrf_token: "t" }));
    renderLogin();
    expect(screen.getByRole("heading", { name: "folio" })).toBeTruthy();
    expect(document.querySelector("main img")).toBeTruthy();
    // Direction D layout: accent glow background, centered 380 px column.
    expect(String(document.querySelector("main")?.className)).toContain("bg-page-glow");
    expect(screen.getByLabelText("Username").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.queryByText(/directory account/)).toBeNull();
  });

  it("toggles password visibility with aria-pressed", () => {
    mockFetch(() => jsonResponse(200, { user, csrf_token: "t" }));
    renderLogin();
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
  });

  it("on bad credentials alerts, marks both fields invalid, clears the password and focuses username", async () => {
    mockFetch(() => jsonResponse(401, { error: { code: "invalid_credentials", message: "Invalid username or password" } }));
    renderLogin();
    await submitCredentials();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Incorrect username or password. Check them and try again.");
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");
    expect(username.getAttribute("aria-invalid")).toBe("true");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect((password as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(username);
    // Never reveal which field was wrong.
    expect(alert.textContent).not.toMatch(/username was wrong|password was wrong/i);
  });

  it("shows Signing in… while the request runs and calls onSuccess on a good login", async () => {
    let resolveLogin: (response: Response) => void = () => {};
    mockFetch(() => new Promise<Response>((resolve) => (resolveLogin = resolve)));
    const onSuccess = renderLogin();
    await submitCredentials();

    const button = screen.getByRole("button", { name: "Signing in…" });
    expect(button.getAttribute("disabled")).not.toBeNull();

    resolveLogin(jsonResponse(200, { user, csrf_token: "t" }));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith(user));
  });
});
