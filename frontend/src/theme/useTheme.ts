import React from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "ccfr-theme";

export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return "dark";
}

export function useTheme() {
  const [theme, setTheme] = React.useState<Theme>(getInitialTheme);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = React.useCallback(
    () => setTheme((current) => (current === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle };
}
