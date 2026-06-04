import { useCallback, useState } from "react";

const STORAGE_KEY = "ccfr.importRoot";

export interface ImportRootState {
  /** The effective root: a stored override if present, otherwise the backend default. */
  root: string;
  /** True when a user-set override differs from the backend default. */
  isOverridden: boolean;
  /** Persist an override (trimmed). Clears it when empty or equal to the default. */
  setRoot: (value: string) => void;
  /** Drop the override and fall back to the backend default. */
  resetToDefault: () => void;
}

/**
 * Holds the active import-source root, persisted per-browser in localStorage and
 * falling back to the backend default (from GET /config) when no override is set.
 */
export function useImportRoot(defaultRoot: string | undefined): ImportRootState {
  const [override, setOverride] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));

  const resetToDefault = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setOverride(null);
  }, []);

  const setRoot = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed === defaultRoot) {
        resetToDefault();
        return;
      }
      localStorage.setItem(STORAGE_KEY, trimmed);
      setOverride(trimmed);
    },
    [defaultRoot, resetToDefault],
  );

  const root = override ?? defaultRoot ?? "";
  const isOverridden = override !== null && override !== defaultRoot;

  return { root, isOverridden, setRoot, resetToDefault };
}
