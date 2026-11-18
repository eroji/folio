/** Admin → Metadata: where book details come from, and the Google Books API
 * key (write-only: the page shows whether one is set and its last four
 * characters). Test runs with the key as typed, else the saved one. */
import { useState } from "react";
import clsx from "clsx";
import { testGoogleBooks, useIntegrations, useSaveIntegrations, type TestResult } from "../api/integrations";
import {
  TestResultLine,
  adminHint,
  adminInput,
  adminLabel,
  adminOutlinePill,
  adminSavePill,
  useTest,
} from "../components/TestResult";

export function AdminMetadata() {
  const { data, error, isPending } = useIntegrations();
  const save = useSaveIntegrations();
  const [key, setKey] = useState("");
  const test = useTest<TestResult>();
  const google = data?.google_books;
  const status = !google
    ? ""
    : google.key_set
      ? `A key is set (${google.key_hint}).`
      : google.env_key
        ? "Using the server’s GOOGLE_BOOKS_API_KEY."
        : "No key: Google answers most lookups with “too many requests” (HTTP 429).";
  return (
    <section aria-labelledby="metadata-h" className="flex flex-col gap-3">
      <h2 id="metadata-h" className="pb-2 font-display text-xl">
        Metadata
      </h2>
      <p className={adminHint}>
        Titles, authors, descriptions and covers come from Open Library (no key needed) and Google Books, which is the
        stronger source for books in other languages. A free key from the Google Cloud console (enable the Books API)
        stops the rate limiting. Keys are stored on the server and never shown again in full.
      </p>
      {isPending && <div className="h-28 animate-pulse rounded-md bg-raised" aria-busy="true" />}
      {error instanceof Error && (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      )}
      {google && (
        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <label htmlFor="google-key" className={adminLabel}>
            Google Books API key
          </label>
          <input
            id="google-key"
            type="password"
            autoComplete="off"
            placeholder={google.key_set ? "Paste a new key to replace it" : "Paste the API key"}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className={adminInput}
          />
          <p className={adminHint}>{status}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!key.trim() || save.isPending}
              onClick={() => save.mutate({ google_books_api_key: key.trim() }, { onSuccess: () => setKey("") })}
              className={adminSavePill}
            >
              Save key
            </button>
            <button
              type="button"
              disabled={test.running}
              onClick={() => void test.run(() => testGoogleBooks(key.trim() || undefined))}
              className={adminOutlinePill}
            >
              {test.running ? "Testing…" : "Test"}
            </button>
            {google.key_set && (
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate({ google_books_api_key: null })}
                className={clsx(adminOutlinePill, "text-danger")}
              >
                Remove key
              </button>
            )}
          </div>
          <TestResultLine result={test.result} label="Google Books test" />
          {save.isError && (
            <p role="alert" className="text-sm text-danger">
              {save.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
