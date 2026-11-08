/** The only place the frontend calls fetch. Attaches X-CSRF-Token from the
 * folio_csrf cookie on mutating requests; unwraps the {"error":{code,message}}
 * envelope into a thrown ApiError whose `message` is safe to show. */

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)folio_csrf=([^;]*)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Listeners told when a request comes back 401: the session is gone (signed
 * out elsewhere, account disabled), so the app must leave for /login now. */
const sessionLost = new Set<() => void>();

/** Subscribe to lost-session 401s; returns the unsubscribe. */
export function onUnauthenticated(listener: () => void): () => void {
  sessionLost.add(listener);
  return () => sessionLost.delete(listener);
}

/** Call for every 401 outside sign-in; also used by the raw fetch/XHR callers. */
export function notifyUnauthenticated(): void {
  for (const listener of sessionLost) listener();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A failed sign-in is a 401 too, but it is the login form's to show.
  if (response.status === 401 && path !== "/auth/login") notifyUnauthenticated();
  if (!response.ok) {
    let code = "request_failed";
    let message = "Something went wrong.";
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      if (payload.error) {
        code = payload.error.code ?? code;
        message = payload.error.message ?? message;
      }
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    throw new ApiError(code, message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** GET a same-origin URL as a Blob (e.g. an audio clip fetched ahead of
 * playback). `url` is a full path as the server returned it. */
async function blob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (response.status === 401) notifyUnauthenticated();
  if (!response.ok) throw new ApiError("request_failed", "Something went wrong.", response.status);
  return response.blob();
}

export const api = {
  blob,
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
