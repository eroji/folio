import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { ListChecks } from "lucide-react";

/** Screen 9 (minimal): read-only job queue. Retry, cache controls and health
 * arrive in M6. */
export function AdminPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ["admin", "jobs"],
    queryFn: () => api.get<Job[] | { items: Job[] }>("/admin/jobs"),
  });
  // T2 owns this endpoint; accept a bare array or an items envelope.
  const jobs = data ? (Array.isArray(data) ? data : data.items) : [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-xl font-semibold">Jobs</h1>
      {isPending && (
        <div className="animate-pulse space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-card bg-card" />
          ))}
        </div>
      )}
      {error instanceof Error && <p className="text-sm text-danger">{error.message}</p>}
      {!isPending && !error && jobs.length === 0 && (
        <EmptyState
          icon={<ListChecks size={28} strokeWidth={1.75} aria-hidden />}
          title="No jobs yet"
          description="Background jobs appear here once books are uploaded."
        />
      )}
      {!isPending && jobs.length > 0 && (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
