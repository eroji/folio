import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

/** Theme with system default: follows prefers-color-scheme until the user
 * pins a choice, which is persisted and applied via [data-theme] on <html>.
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
  const theme: Theme =
    choice === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;

  useEffect(() => {
    if (choice === "system") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("folio-theme");
    } else {
      document.documentElement.dataset.theme = choice;
      localStorage.setItem("folio-theme", choice);
    }
  }, [choice]);

  const toggle = useCallback(() => setChoice(theme === "dark" ? "light" : "dark"), [theme]);
  return { theme, choice, toggle, select: setChoice };
}
