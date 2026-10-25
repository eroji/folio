import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Theme with system default. `data-theme` on <html> is always "light" or
 * "dark": a stored choice wins; "system" resolves prefers-color-scheme and
 * follows it live while selected. Only explicit choices are persisted, so
 * `select("system")` clears the pin again. */
export function useTheme(): {
  theme: Theme;
  choice: ThemeChoice;
  toggle: () => void;
  select: (choice: ThemeChoice) => void;
} {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem("folio-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [resolved, setResolved] = useState<Theme>(systemTheme);

  useEffect(() => {
    if (choice !== "system" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mql.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, [choice]);

  const theme: Theme = choice === "system" ? resolved : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (choice === "system") localStorage.removeItem("folio-theme");
    else localStorage.setItem("folio-theme", choice);
  }, [theme, choice]);

  const toggle = useCallback(() => setChoice(theme === "dark" ? "light" : "dark"), [theme]);
  return { theme, choice, toggle, select: setChoice };
}
