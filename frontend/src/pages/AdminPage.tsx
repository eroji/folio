import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job, User } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";

/** Body of GET /admin/cache (plan M6 Task A2). */
interface CacheStats {
  files: number;
  bytes: number;
  tts: { status: string; latency_ms: number | null };
}

/** Body of GET /admin/voice-names (voice display names). */
interface VoiceNamesResponse {
  names: Record<string, string>;
  items: { id: string; display_name: string; overridden: boolean }[];
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const cellButton = "tap grid size-10 place-items-center rounded-full text-fg hover:bg-raised disabled:opacity-40";
const inputClass = "tap h-10 w-full rounded-full border border-border bg-raised px-4 text-md";
const sectionTitle = "font-display text-lg";
const pill = "rounded-full bg-raised px-2.5 py-0.5 text-xs text-fg-2";

/** Screen 9: job queue with retry, TTS status, audio cache controls, users. */
export function AdminPage() {
  const queryClient = useQueryClient();
  const [clearError, setClearError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});
  const [namesSaved, setNamesSaved] = useState(false);

  const jobsQuery = useQuery({
    queryKey: ["admin", "jobs"],
    queryFn: () => api.get<Job[] | { items: Job[] }>("/admin/jobs"),
  });
  // T2 owns this endpoint; accept a bare array or an items envelope.
  const jobs = jobsQuery.data ? (Array.isArray(jobsQuery.data) ? jobsQuery.data : jobsQuery.data.items) : [];

  const cacheQuery = useQuery({
    queryKey: ["admin", "cache"],
    queryFn: () => api.get<CacheStats>("/admin/cache"),
  });
  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.get<{ items: User[] }>("/admin/users"),
  });
  const voiceNamesQuery = useQuery({
    queryKey: ["admin", "voice-names"],
    queryFn: () => api.get<VoiceNamesResponse>("/admin/voice-names"),
  });

  const retry = useMutation({
    mutationFn: (id: Job["id"]) => api.post<{ job: Job }>(`/admin/jobs/${id}/retry`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] }),
  });
  const clear = useMutation({
    mutationFn: () => api.post<{ removed_files: number; freed_bytes: number }>("/admin/cache/clear", {}),
    onSuccess: () => {
      setClearError(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "cache"] });
    },
    onError: (error: Error) => setClearError(error.message),
  });

  // PUT replaces the whole override map: send untouched overrides, drop cleared ones.
  const saveNames = useMutation({
    mutationFn: () => {
      const data = voiceNamesQuery.data;
      const names: Record<string, string> = {};
      for (const item of data?.items ?? []) {
        const value = (nameDraft[item.id] ?? data?.names[item.id] ?? "").trim();
        if (value) names[item.id] = value;
      }
      return api.put<{ names: Record<string, string> }>("/admin/voice-names", { names });
    },
    onSuccess: () => {
      setNameDraft({});
      setNamesSaved(true);
      queryClient.invalidateQueries({ queryKey: ["admin", "voice-names"] });
      queryClient.invalidateQueries({ queryKey: ["voices"] });
    },
  });

  const stats = cacheQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Jobs" className="flex flex-col gap-2">
        <h1 className="font-display text-xl">Jobs</h1>
        {jobsQuery.isPending && (
          <div className="animate-pulse space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded-md bg-raised" />
            ))}
          </div>
        )}
        {jobsQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{jobsQuery.error.message}</p>}
        {!jobsQuery.isPending && !jobsQuery.error && jobs.length === 0 && (
          <EmptyState
            icon={<Icon name="CircleCheck" size={24} />}
            title="No jobs yet"
            description="Background jobs appear here once books are uploaded."
          />
        )}
        {retry.isError && (
          <p role="alert" className="text-sm text-danger">
            Couldn’t retry this job — {retry.error.message}
          </p>
        )}
        {!jobsQuery.isPending && jobs.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-left text-base">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-fg-2">
                <tr>
                  <th className="px-3 py-2 font-medium">ID</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Book</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Error</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-t border-border first:border-0">
                    <td className="px-3 py-2 tabular">{job.id}</td>
                    <td className="px-3 py-2">{job.type}</td>
                    <td className="px-3 py-2">
                      <span className={pill}>{job.status}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{job.book_id?.slice(0, 8) ?? "—"}</td>
                    <td className="px-3 py-2 tabular">{job.attempts}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(job.created_at).toLocaleString()}</td>
                    <td className="max-w-60 truncate px-3 py-2 text-fg-2" title={job.error ?? undefined}>
                      {job.error ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {job.status === "failed" && (
                        <button
                          type="button"
                          aria-label={`Retry job ${job.id}`}
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(job.id)}
                          className={cellButton}
                        >
                          <Icon name="RefreshCw" size={18} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Audio cache" className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Audio cache</h2>
        {cacheQuery.isPending && <div className="h-9 animate-pulse rounded-md bg-raised" aria-busy="true" />}
        {cacheQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{cacheQuery.error.message}</p>}
        {stats && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4 text-base">
            <p className="tabular">
              {stats.files.toLocaleString()} files · {formatBytes(stats.bytes)}
            </p>
            <p>
              TTS:{" "}
              <span className={stats.tts.status === "ok" ? "font-medium" : "font-medium text-danger"}>{stats.tts.status}</span>
              {stats.tts.latency_ms != null && <span className="tabular text-fg-2"> · {Math.round(stats.tts.latency_ms)} ms</span>}
            </p>
            <button
              type="button"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              className="tap ml-auto inline-flex h-10 items-center rounded-full border border-danger px-4 text-base font-semibold text-danger hover:bg-raised disabled:opacity-50"
            >
              Clear cache
            </button>
          </div>
        )}
        {clearError && (
          <p role="alert" className="text-sm text-danger">
            {clearError}
          </p>
        )}
      </section>

      <section aria-label="Users" className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Users</h2>
        {usersQuery.isPending && <div className="h-9 animate-pulse rounded-md bg-raised" aria-busy="true" />}
        {usersQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{usersQuery.error.message}</p>}
        {usersQuery.data && usersQuery.data.items.length === 0 && (
          <p className="text-sm text-fg-2">No users have signed in yet.</p>
        )}
        {usersQuery.data && usersQuery.data.items.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {usersQuery.data.items.map((user) => (
              <li key={user.id} className="tap flex min-h-9 items-center gap-3 px-4 py-1 text-base">
                <span className="min-w-0 flex-1 truncate font-medium">{user.display_name}</span>
                <span className="truncate text-fg-2">{user.username}</span>
                <span className={pill}>{user.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Voice names" className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Voice names</h2>
        {voiceNamesQuery.isPending && (
          <div className="animate-pulse space-y-2" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="h-12 rounded-md bg-raised" />
            ))}
          </div>
        )}
        {voiceNamesQuery.error instanceof Error && (
          <p role="alert" className="text-sm text-danger">{voiceNamesQuery.error.message}</p>
        )}
        {voiceNamesQuery.data && voiceNamesQuery.data.items.length === 0 && (
          <EmptyState
            icon={<Icon name="Speech" size={24} />}
            title="No voices found"
            description="Discovered voices appear here once the TTS backend answers."
          />
        )}
        {saveNames.isError && (
          <p role="alert" className="text-sm text-danger">Couldn’t save the names — {saveNames.error.message}</p>
        )}
        {voiceNamesQuery.data && voiceNamesQuery.data.items.length > 0 && (
          <>
            <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
              {voiceNamesQuery.data.items.map((item) => (
                <li key={item.id} className="flex min-h-9 items-center gap-3 px-4 py-2">
                  <label className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-fg-2">{item.id}</span>
                    <input
                      type="text"
                      maxLength={40}
                      aria-label={`Display name for ${item.id}`}
                      value={nameDraft[item.id] ?? voiceNamesQuery.data?.names[item.id] ?? item.display_name}
                      onChange={(event) => {
                        setNamesSaved(false);
                        const value = event.target.value;
                        setNameDraft((draft) => ({ ...draft, [item.id]: value }));
                      }}
                      className={inputClass}
                    />
                  </label>
                  {item.overridden && <span className={pill}>Custom</span>}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={saveNames.isPending}
                onClick={() => saveNames.mutate()}
                className="tap inline-flex h-10 items-center rounded-full bg-fg px-4 text-base font-bold text-on-fg disabled:opacity-50"
              >
                Save
              </button>
              {namesSaved && <span className="text-sm text-fg-2">Saved</span>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
