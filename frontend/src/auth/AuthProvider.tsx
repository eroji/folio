import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api, onUnauthenticated } from "../api/client";
import type { AuthPayload, User } from "../api/types";

interface AuthValue {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    api
      .get<AuthPayload>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  // Any 401 means the session is gone (signed out elsewhere, account disabled
  // or locked): drop the user so RequireAuth sends them to /login at once.
  useEffect(() => onUnauthenticated(() => setUser(null)), []);

  // Coming back to the app re-checks the session (and lets /me re-issue the
  // cookies). Only a 401 signs out; an offline check keeps the user in.
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      api
        .get<AuthPayload>("/auth/me")
        // Keep the same object when nothing changed so the app does not re-render.
        .then((data) =>
          setUser((prev) =>
            prev && prev.id === data.user.id && prev.role === data.user.role ? prev : data.user,
          ),
        )
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const data = await api.post<AuthPayload>("/auth/login", { username, password });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // The local session is gone either way; the server error is not the user's problem.
    }
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, isLoading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}

/** Gate for the app shell: bootstraps on /auth/me, bounces guests to /login. */
export function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl animate-pulse space-y-3 p-4" aria-busy="true">
        <div className="h-12 rounded-lg bg-surface" />
        <div className="h-64 rounded-lg bg-surface" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
