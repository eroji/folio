export type Role = "admin" | "user";

export interface User {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
}

/** Body of POST /auth/login and GET /auth/me. */
export interface AuthPayload {
  user: User;
  csrf_token: string;
}

/** Row of GET /admin/jobs (Job model, plan T1/T2). */
export interface Job {
  id: number;
  type: string;
  book_id: string | null;
  priority: number;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}
