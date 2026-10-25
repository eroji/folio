import clsx from "clsx";

/** 44×26 pill switch (Direction D): on = accent track with a dark knob,
 * off = --color-off track with a white knob. `role="switch"` + aria-checked. */
export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="tap grid size-11 shrink-0 place-items-center rounded-full"
    >
      <span
        aria-hidden
        className={clsx(
          "relative block h-6.5 w-11 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-off",
        )}
      >
        <span
          className={clsx(
            "absolute top-[3px] left-[3px] size-5 rounded-full transition-transform",
            checked ? "translate-x-[18px] bg-on-fg" : "bg-fg",
          )}
        />
      </span>
    </button>
  );
}
