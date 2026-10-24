import { Link } from "react-router-dom";
import { Library } from "lucide-react";
import { EmptyState } from "../components/EmptyState";

/** Screen 2 (home). The catalog grid and Continue listening row arrive in T9/M5;
 * the empty state ships now with the spec's exact copy. */
export function LibraryPage() {
  return (
    <EmptyState
      icon={<Library size={28} strokeWidth={1.75} aria-hidden />}
      title="No books yet"
      description="Upload your first EPUB, PDF or Kindle file."
      action={
        <Link
          to="/upload"
          className="mt-2 inline-flex h-12 items-center justify-center rounded-pill bg-brand-gradient px-6 font-display font-semibold text-white"
        >
          Upload a book
        </Link>
      }
    />
  );
}
