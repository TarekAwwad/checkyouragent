import React from "react";

// First-run discovery hint for the glossary. We pulse the help button and show
// a one-time coachmark until the user either opens the glossary or dismisses
// the hint; the "seen" flag is persisted so it never nags again.
const STORAGE_KEY = "ccfr-glossary-hint-seen";

function getInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useGlossaryHint() {
  const [seen, setSeen] = React.useState<boolean>(getInitial);

  const dismiss = React.useCallback(() => {
    setSeen(true);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  return { seen, dismiss };
}
