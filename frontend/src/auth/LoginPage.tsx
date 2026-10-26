import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useAuth } from "./AuthProvider";
import { ApiError } from "../api/client";
import { Icon } from "../components/Icon";
import folioMark from "../assets/folio-mark.svg";
import type { User } from "../api/types";

/** Never reveal which of the two was wrong (handoff "Sign in"). */
const BAD_CREDENTIALS = "Incorrect username or password. Check them and try again.";

/** Direction D "Sign in": the accent glow background, a centered 380 px
 * column, 48 px pill inputs and a 52 px white pill button. Same on phone. */
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
    "h-12 w-full rounded-full border bg-raised px-[18px] text-lg text-fg",
    error ? "border-danger" : "border-border",
  );

  return (
    <main className="bg-page-glow flex min-h-dvh flex-col items-center justify-center px-6 py-12 pt-safe pb-safe">
      <div className="flex w-full max-w-[380px] flex-col gap-8">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <img src={folioMark} alt="" width={64} height={64} />
          <h1 className="font-display text-[34px] leading-none">folio</h1>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-2xl border border-danger px-4 py-3 text-sm leading-snug text-danger">
              <Icon name="TriangleAlert" size={18} className="mt-px shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col gap-2">
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

          <div className="flex flex-col gap-2">
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
                className={clsx(field, "pr-[52px]")}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
                className="tap absolute top-1 right-1 grid size-10 place-items-center rounded-full text-fg-2 hover:bg-raised"
              >
                <Icon name={showPassword ? "EyeOff" : "Eye"} size={20} />
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="tap mt-2 h-[52px] rounded-full bg-fg text-lg font-bold text-on-fg disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      {testMode && (
        <section className="mt-8 flex w-full max-w-[380px] flex-col gap-3 rounded-2xl border border-dashed border-border p-4 text-fg-2">
          <p className="text-sm font-medium">Test mode: sign in without LDAP</p>
          <div className="flex gap-2">
            <input
              aria-label="Test username"
              value={testUser}
              onChange={(e) => setTestUser(e.target.value)}
              className="tap h-10 min-w-0 flex-1 rounded-full border border-border bg-raised px-4 text-sm text-fg"
            />
            <select
              aria-label="Test role"
              value={testRole}
              onChange={(e) => setTestRole(e.target.value)}
              className="select-pill tap h-10 border border-border bg-raised text-sm text-fg"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="button" onClick={testSignIn} className="tap h-10 rounded-full border border-border text-sm font-semibold text-fg hover:bg-raised">
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
