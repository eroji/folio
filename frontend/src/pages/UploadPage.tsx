import { Upload } from "lucide-react";
import { EmptyState } from "../components/EmptyState";

/** Placeholder route. The real dropzone ships in T9; no fake features. */
export function UploadPage() {
  return (
    <EmptyState
      icon={<Upload size={28} strokeWidth={1.75} aria-hidden />}
      title="Upload"
      description="Upload is coming in the next milestone."
    />
  );
}
