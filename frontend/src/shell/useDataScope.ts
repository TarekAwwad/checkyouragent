import React from "react";

// Which dataset the app is looking at: the single-user local index on this
// machine, or the aggregated team bundles. A pure client-side UI lens
// (persisted to localStorage), not server state.
export type DataScope = "local" | "team";

const STORAGE_KEY = "ccfr.dataScope";

function getInitial(): DataScope {
  try {
    return localStorage.getItem(STORAGE_KEY) === "team" ? "team" : "local";
  } catch {
    return "local";
  }
}

export function useDataScope() {
  const [scope, setScopeState] = React.useState<DataScope>(getInitial);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, scope);
    } catch {
      /* ignore */
    }
  }, [scope]);

  const setScope = React.useCallback((next: DataScope) => setScopeState(next), []);

  return { scope, setScope };
}
