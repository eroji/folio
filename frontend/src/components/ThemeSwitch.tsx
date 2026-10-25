import clsx from "clsx";
import type { ThemeChoice } from "../hooks/useTheme";

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Segmented System / Light / Dark switch, shared by the account menu and
 * Settings so both places are one control changing the same folio-theme
 * setting (`useTheme`). Inside a `role="menu"` the buttons must stay
 * `menuitemradio` to take part in the menu's arrow-key cycling; everywhere
 * else they are plain `radio`s in a `radiogroup`. */
export function ThemeSwitch({
  choice,
  onSelect,
  role = "radio",
}: {
  choice: ThemeChoice;
  onSelect: (choice: ThemeChoice) => void;
  role?: "radio" | "menuitemradio";
}) {
  return (
    <div
      role={role === "radio" ? "radiogroup" : "group"}
      aria-label="Theme"
      className="flex gap-0.5 rounded-md border border-divider bg-raised p-0.5"
    >
      {THEMES.map((theme) => (
        <button
          key={theme.value}
          type="button"
          role={role}
          aria-checked={choice === theme.value}
          onClick={() => onSelect(theme.value)}
          className={clsx(
            "tap h-7 rounded-md px-3 text-sm",
            choice === theme.value
              ? "bg-surface font-semibold text-fg shadow-sm"
              : "font-medium text-fg-2",
          )}
        >
          {theme.label}
        </button>
      ))}
    </div>
  );
}
