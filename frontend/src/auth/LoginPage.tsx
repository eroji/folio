import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "./AuthProvider";
import { ApiError } from "../api/client";
import { Icon } from "../components/Icon";
import type { User } from "../api/types";

/** Never reveal which of the two was wrong (handoff "Sign in"). */
const BAD_CREDENTIALS = "Incorrect username or password. Check them and try again.";

/** Desktop: 440 px card centered on the page background. Phone: the same
 * content on the surface, starting ~96 px from the top. */
export function LoginPage({ onSuccess }: { onSuccess?: (user: User) => void }) {
  const { user, isLoading, login } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const usernameRef = useRef<HTMLInputElement>(null);
  // Dev-only convenience: when the server runs with FOLIO_TEST_MODE, let a
  // browser session sign in without an LDAP server. Never rendered otherwise.
  const [testMode, setTestMode] = useState(false);
  const [testUser, setTestUser] = useState("dev-user");
  const [testRole, setTestRole] = useState("admin");

  useEffect(() => {
    fetch("/api/v1/auth/options")
      .then((r) => r.json())
      .then((data: { test_mode?: boolean }) => setTestMode(Boolean(data.test_mode)))
      .catch(() => setTestMode(false));
  }, []);

  // After a failed attempt focus moves to the username field.
  useEffect(() => {
    if (attempts > 0) usernameRef.current?.focus();
  }, [attempts]);

  async function testSignIn() {
    setError(null);
    const response = await fetch("/api/v1/test/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: testUser, role: testRole }),
    });
    if (!response.ok) {
      setError("Test sign-in failed.");
      return;
    }
    window.location.assign("/");
  }

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const signedIn = await login(username, password);
      onSuccess?.(signedIn);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? BAD_CREDENTIALS : err instanceof Error ? err.message : "Something went wrong.");
      setPassword("");
      setAttempts((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  }

  const field = clsx(
    "h-11 w-full rounded-md border bg-surface px-3 text-md desktop:h-10",
    error ? "border-danger" : "border-control-border",
  );

  return (
    <main className="flex min-h-dvh flex-col items-center bg-surface px-6 pt-24 pb-8 pt-safe desktop:justify-center desktop:bg-bg desktop:pt-8">
      <div className="flex w-full max-w-[440px] flex-col gap-7 desktop:rounded-lg desktop:border desktop:border-divider desktop:bg-surface desktop:p-10">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <img src="/logo.svg" alt="" className="size-11" />
          <h1 className="font-display text-[28px] font-bold leading-none tracking-[-0.01em]">Folio</h1>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-danger px-3 py-2.5 text-sm leading-snug text-danger">
              <Icon name="error" size={18} className="mt-px shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="folio-username" className="text-sm font-semibold">
              Username
            </label>
            <input
              id="folio-username"
              ref={usernameRef}
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              disabled={isLoading || submitting}
              aria-invalid={error ? true : undefined}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={field}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="folio-password" className="text-sm font-semibold">
              Password
            </label>
            <div className="relative">
              <input
                id="folio-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                disabled={isLoading || submitting}
                aria-invalid={error ? true : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={clsx(field, "pr-11")}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
                className="tap absolute top-1/2 right-0.5 grid size-9 -translate-y-1/2 place-items-center rounded-md text-fg-2 hover:bg-raised"
              >
                <Icon name={showPassword ? "visibility_off" : "visibility"} />
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="tap h-12 rounded-md bg-primary-gradient text-md font-bold disabled:opacity-60 desktop:h-11"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      {testMode && (
        <section className="mt-8 flex w-full max-w-[440px] flex-col gap-3 rounded-lg border border-dashed border-divider p-4 text-fg-2">
          <p className="text-sm font-medium">Test mode: sign in without LDAP</p>
          <div className="flex gap-2">
            <input
              aria-label="Test username"
              value={testUser}
              onChange={(e) => setTestUser(e.target.value)}
              className="tap h-11 min-w-0 flex-1 rounded-md border border-control-border bg-surface px-3 text-sm desktop:h-9"
            />
            <select
              aria-label="Test role"
              value={testRole}
              onChange={(e) => setTestRole(e.target.value)}
              className="tap h-11 rounded-md border border-control-border bg-surface px-3 text-sm desktop:h-9"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="button" onClick={testSignIn} className="tap h-11 rounded-md border border-control-border bg-surface text-sm font-medium desktop:h-9">
            Test sign in
          </button>
          <p className="text-xs">
            Only available when the server sets FOLIO_TEST_MODE. Never enable it in production.
          </p>
        </section>
      )}
    </main>
  );
}
