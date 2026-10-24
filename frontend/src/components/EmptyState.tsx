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
      <div className="grid h-16 w-16 place-items-center rounded-pill bg-brand-gradient text-white">
        {icon}
      </div>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}
