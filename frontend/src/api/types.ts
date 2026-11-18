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
  /** Direction D genre (fixed suggestion list, free text allowed). */
  genre?: string | null;
  narrator_voice: string | null;
  /** How to narrate this book (language model or hand-written); joins the
   * voice's style prompt when the speech engine takes one. */
  delivery_note?: string | null;
  cover_url: string | null;
  /** "r g b" dominant cover color for the glow; null until a cover is stored. */
  cover_rgb?: string | null;
  status: BookStatus;
  error: string | null;
  /** Server-computed: the caller is an admin or uploaded this book. Absent on
   * payloads predating M6 — fall back to `role === "admin"`. */
  can_edit?: boolean;
  /** Field names protected from automatic updates (Edit details locks). Absent
   * until the backend workstream lands the unlock endpoint. */
  locked_fields?: string[];
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
  /** Excluded chapters are skipped by playback; absent means included. */
  excluded?: boolean;
  /** This listener's place in the chapter; null/absent: never played. */
  progress?: ChapterProgress | null;
}

export interface ChapterProgress {
  /** Null: start of the chapter (a finished chapter starts over). */
  segment_id: string | null;
  offset_s: number;
  /** How far into the chapter, by characters. */
  percent: number;
  /** Heard to the end at least once. */
  finished: boolean;
}

export interface BookListResponse {
  items: Book[];
  total: number;
  page: number;
  page_size: number;
}

/** Row of the progress table (plan Task P contract). percent is
 * character-based, computed server-side; never from audio duration. */
export interface Progress {
  chapter_id: string;
  segment_id: string;
  offset_s: number;
  percent: number;
  device_label: string;
  updated_at: string;
  finished_at: string | null;
}

/** Body of GET /books/{id}; progress is the caller's row (plan Task P). */
export interface BookDetailResponse {
  book: Book;
  chapters: Chapter[];
  progress: Progress | null;
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
  /** True when this provider cover is already the book's cover (server-side). */
  cover_applied?: boolean;
  score: number;
  /** Genre derived from the provider subjects; absent until the backend lands. */
  suggested_genre?: string | null;
}

/** Row of GET /admin/jobs (Job model, plan T1/T2). */
export interface Job {
  id: string;
  type: string;
  book_id: string | null;
  /** Joined from the book row so the admin table reads without UUIDs. */
  book_title?: string | null;
  /** Joined from the user row; null for worker/system jobs. */
  user_name?: string | null;
  user_username?: string | null;
  priority: number;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}
