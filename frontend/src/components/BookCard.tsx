import { Link } from "react-router-dom";
import clsx from "clsx";
import { StatusBadge } from "./StatusBadge";
import type { Book } from "../api/types";

/** Cover image or the brand-gradient placeholder with title/author (spec "Brand"). */
export function BookCover({ book, className }: { book: Book; className?: string }) {
  if (book.cover_url) {
    return <img src={book.cover_url} alt="" loading="lazy" className={clsx("bg-page object-cover", className)} />;
  }
  return (
    <div className={clsx("bg-brand-gradient flex flex-col justify-end gap-1 p-3 text-white", className)} aria-hidden>
      <p className="line-clamp-4 font-display text-sm font-semibold leading-tight">{book.title}</p>
      {book.authors[0] && <p className="line-clamp-1 text-xs opacity-80">{book.authors[0]}</p>}
    </div>
  );
}

/** Grid card for Screen 2. */
export function BookCard({ book }: { book: Book }) {
  return (
    <Link
      to={`/books/${book.id}`}
      className="flex flex-col gap-2 rounded-card bg-card p-2 shadow-sm transition hover:shadow-md"
    >
      <BookCover book={book} className="aspect-[2/3] w-full rounded-card" />
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-medium">{book.title}</p>
        <p className="line-clamp-1 text-xs text-muted">{book.authors.join(", ")}</p>
      </div>
      <StatusBadge status={book.status} />
    </Link>
  );
}
