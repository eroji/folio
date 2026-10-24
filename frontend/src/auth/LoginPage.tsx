import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { useTheme } from "../hooks/useTheme";
import type { User } from "../api/types";

/** Screen 1: logo, "Sign in with your directory account", username, password,
 * sign-in button; errors inline. Calls onSuccess(user) after a good login. */
export function LoginPage({ onSuccess }: { onSuccess?: (user: User) => void }) {
  const { user, isLoading, login } = useAuth();
  const location = useLocation();
  const { theme } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      setError(err instanceof Error ? err.message : "Invalid username or password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[390px] flex-col justify-center gap-8 px-6 pt-safe pb-safe">
      <div className="flex flex-col items-center gap-4 text-center">
        <img
          src={theme === "dark" ? "/logo-wordmark-dark.svg" : "/logo-wordmark.svg"}
          alt="Folio"
          className="h-10 w-auto"
        />
        <h1 className="font-display text-2xl font-semibold">Sign in with your directory account</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Username</span>
          <input
            type="text"
            name="username"
            autoComplete="username"
            autoFocus
            required
            disabled={isLoading || submitting}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="h-11 rounded-card border border-line bg-card px-3 text-base outline-none focus-visible:border-brand-blue"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            disabled={isLoading || submitting}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 rounded-card border border-line bg-card px-3 text-base outline-none focus-visible:border-brand-blue"
          />
        </label>

        {error && (
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle size={18} strokeWidth={1.75} aria-hidden />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-2 flex h-12 items-center justify-center rounded-pill bg-brand-gradient font-display text-base font-semibold text-white disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
