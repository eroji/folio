/** Admin (Direction D §4, same layout as Settings): title, left section
 * pills (roving-tabindex tablist) and one tabpanel — only the selected
 * section renders. The root wrapper and the two-column grid use exactly
 * Settings' classes so both pages share one content column, and the panels
 * render flat on the page background with divider rows, like Settings' rows. */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job, User } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { AdminVoices } from "./AdminVoices";

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

const SECTIONS = [
  { id: "jobs", label: "Jobs" },
  { id: "cache", label: "Cache" },
  { id: "users", label: "Users" },
  { id: "voices", label: "Voices" },
] as const;

const cellButton = "tap grid size-10 place-items-center rounded-full text-fg hover:bg-raised disabled:opacity-40";
const sectionTitle = "pb-2 font-display text-xl";
const pill = "rounded-full bg-raised px-2.5 py-0.5 text-xs text-fg-2";

/** Screen 9: job queue with retry, TTS status, audio cache controls, users. */
export function AdminPage() {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<string>("jobs");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
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

  /** roving-tabindex tablist: arrows / Home / End move selection and focus. */
  function onTabKeyDown(event: ReactKeyboardEvent, index: number) {
    const last = SECTIONS.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    const id = SECTIONS[next]!.id;
    setSection(id);
    tabRefs.current.get(id)?.focus();
  }

  const stats = cacheQuery.data;

  return (
    <div className="flex flex-col gap-8 pt-6">
      <h1 className="font-display text-3xl">Admin</h1>
      <div className="flex flex-wrap items-start gap-8 lg:gap-12">
        <div role="tablist" aria-label="Admin sections" className="flex w-full flex-col gap-1 lg:w-52">
          {SECTIONS.map(({ id, label }, index) => (
            <button
              key={id}
              ref={(node) => {
                if (node) tabRefs.current.set(id, node);
                else tabRefs.current.delete(id);
              }}
              type="button"
              role="tab"
              id={`admin-tab-${id}`}
              aria-selected={section === id}
              aria-controls="admin-panel"
              tabIndex={section === id ? 0 : -1}
              onClick={() => setSection(id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={clsx(
                "tap flex h-11 items-center rounded-full px-4 text-left text-md",
                section === id ? "bg-raised font-bold text-fg" : "font-medium text-fg-2 hover:bg-raised",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          id="admin-panel"
          role="tabpanel"
          aria-labelledby={`admin-tab-${section}`}
          tabIndex={-1}
          className="flex w-full min-w-0 flex-1 flex-col gap-10 lg:max-w-[760px]"
        >
          {section === "jobs" && (
            <section aria-label="Jobs" className="flex flex-col gap-2">
              <h2 className={sectionTitle}>Jobs</h2>
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
                <div className="overflow-x-auto">
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
          )}

          {section === "cache" && (
            <section aria-label="Audio cache" className="flex flex-col gap-2">
              <h2 className={sectionTitle}>Audio cache</h2>
              {cacheQuery.isPending && <div className="h-9 animate-pulse rounded-md bg-raised" aria-busy="true" />}
              {cacheQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{cacheQuery.error.message}</p>}
              {stats && (
                <div className="flex flex-wrap items-center gap-3 text-base">
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
          )}

          {section === "users" && (
            <section aria-label="Users" className="flex flex-col gap-2">
              <h2 className={sectionTitle}>Users</h2>
              {usersQuery.isPending && <div className="h-9 animate-pulse rounded-md bg-raised" aria-busy="true" />}
              {usersQuery.error instanceof Error && <p role="alert" className="text-sm text-danger">{usersQuery.error.message}</p>}
              {usersQuery.data && usersQuery.data.items.length === 0 && (
                <p className="text-sm text-fg-2">No users have signed in yet.</p>
              )}
              {usersQuery.data && usersQuery.data.items.length > 0 && (
                <ul className="divide-y divide-border">
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
          )}

          {section === "voices" && <AdminVoices />}
        </div>
      </div>
    </div>
  );
}
