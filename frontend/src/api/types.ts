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

export type BookStatus = "uploading" | "processing" | "ready" | "needs_ocr" | "failed";

/** Row of GET /books and GET /books/{id} (Book model, plan T8). */
export interface Book {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  series: string | null;
  series_index: number | null;
  description: string | null;
  publisher: string | null;
  published_date: string | null;
  language: string;
  isbn10: string | null;
  isbn13: string | null;
  tags: string[];
  narrator_voice: string | null;
  cover_url: string | null;
  status: BookStatus;
  error: string | null;
  total_chars: number;
  est_duration_s: number | null;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: string;
  idx: number;
  title: string;
  char_count: number;
}

export interface BookListResponse {
  items: Book[];
  total: number;
  page: number;
  page_size: number;
}

/** Body of GET /books/{id}. progress stays null until M5. */
export interface BookDetailResponse {
  book: Book;
  chapters: Chapter[];
  progress: null;
}

/** One entry of the POST /books response array. */
export interface UploadResult {
  book_id: string;
  job_id: string | null;
  duplicate_of: string | null;
}

/** data: payload of an `event: job` / `event: book` frame on GET /events. */
export interface EventFrame {
  event: string;
  job_id?: string | null;
  book_id: string;
  status: string;
}

/** One metadata candidate (plan T-B/T-D contract). `source` is "openlibrary" | "googlebooks". */
export interface Candidate {
  id?: string;
  source: string;
  title: string;
  authors: string[];
  published_date: string | null;
  publisher: string | null;
  description: string | null;
  language: string | null;
  isbn10: string | null;
  isbn13: string | null;
  series: string | null;
  series_index: number | null;
  tags: string[];
  cover_url: string | null;
  score: number;
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
