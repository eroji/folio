import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { Job, User } from "../api/types";
import { EmptyState } from "../components/EmptyState";

/** Body of GET /admin/cache (plan M6 Task A2). */
interface CacheStats {
  files: number;
  bytes: number;
  tts: { status: string; latency_ms: number | null };
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

const cellButton = "grid min-h-11 min-w-11 place-items-center rounded-pill border border-line bg-card hover:bg-page";

/** Screen 9: job queue with retry, TTS status, audio cache controls, users. */
export function AdminPage() {
  const queryClient = useQueryClient();
  const [clearError, setClearError] = useState<string | null>(null);

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

  const stats = cacheQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Jobs" className="flex flex-col gap-2">
        <h1 className="font-display text-xl font-semibold">Jobs</h1>
        {jobsQuery.isPending && (
          <div className="animate-pulse space-y-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded-card bg-card" />
            ))}
          </div>
        )}
        {jobsQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{jobsQuery.error.message}</p>}
        {!jobsQuery.isPending && !jobsQuery.error && jobs.length === 0 && (
          <EmptyState
            icon={<ListChecks size={28} strokeWidth={1.75} aria-hidden />}
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
          <div className="overflow-x-auto rounded-card border border-line bg-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
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
                  <tr key={job.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 tabular-nums">{job.id}</td>
                    <td className="px-3 py-2">{job.type}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-pill bg-page px-2 py-0.5 text-xs">{job.status}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{job.book_id?.slice(0, 8) ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{job.attempts}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(job.created_at).toLocaleString()}</td>
                    <td className="max-w-60 truncate px-3 py-2 text-muted" title={job.error ?? undefined}>
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
                          <RotateCcw size={18} strokeWidth={1.75} aria-hidden />
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
        <h2 className="font-display text-xl font-semibold">Audio cache</h2>
        {cacheQuery.isPending && <div className="h-12 animate-pulse rounded-card bg-card" aria-busy="true" />}
        {cacheQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{cacheQuery.error.message}</p>}
        {stats && (
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-card px-4 py-3 text-sm">
            <p className="tabular-nums">
              {stats.files.toLocaleString()} files · {formatBytes(stats.bytes)}
            </p>
            <p>
              TTS:{" "}
              <span className={stats.tts.status === "ok" ? "font-medium" : "font-medium text-danger"}>{stats.tts.status}</span>
              {stats.tts.latency_ms != null && <span className="tabular-nums text-muted"> · {Math.round(stats.tts.latency_ms)} ms</span>}
            </p>
            <button
              type="button"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-pill border border-line bg-page px-4 text-sm font-medium text-danger disabled:opacity-50"
            >
              <Trash2 size={18} strokeWidth={1.75} aria-hidden />
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
        <h2 className="font-display text-xl font-semibold">Users</h2>
        {usersQuery.isPending && <div className="h-12 animate-pulse rounded-card bg-card" aria-busy="true" />}
        {usersQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{usersQuery.error.message}</p>}
        {usersQuery.data && usersQuery.data.items.length === 0 && (
          <p className="text-sm text-muted">No users have signed in yet.</p>
        )}
        {usersQuery.data && usersQuery.data.items.length > 0 && (
          <ul className="divide-y divide-line rounded-card border border-line bg-card">
            {usersQuery.data.items.map((user) => (
              <li key={user.id} className="flex min-h-11 items-center gap-3 px-4 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{user.display_name}</span>
                <span className="truncate text-muted">{user.username}</span>
                <span className="rounded-pill bg-page px-2 py-0.5 text-xs">{user.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
