import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-raised text-fg-2">
        {icon}
      </div>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {description && (
        <p className="max-w-sm text-sm text-fg-2">{description}</p>
      )}
      {action}
    </div>
  );
}
