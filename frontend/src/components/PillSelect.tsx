/** Pill-styled native select with a chevron (Settings and Admin rows). */
import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

const selectPill = "select-pill tap h-10 border border-border bg-raised text-base text-fg";
const selectChevron = "pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-fg-2";

export function PillSelect({
  ariaLabel,
  width,
  value,
  disabled,
  onChange,
  children,
}: {
  ariaLabel: string;
  width: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className={clsx("relative inline-flex", width, "max-w-full")}>
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(selectPill, "w-full")}
      >
        {children}
      </select>
      <Icon name="ChevronDown" size={18} className={selectChevron} />
    </span>
  );
}
