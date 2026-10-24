import { BookOpen } from "lucide-react";
import { useParams } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";

/** Placeholder route. Book detail ships in T9; no fake features. */
export function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <EmptyState
      icon={<BookOpen size={28} strokeWidth={1.75} aria-hidden />}
      title="Book"
      description={`Book ${id ?? ""} is coming in the next milestone.`}
    />
  );
}
