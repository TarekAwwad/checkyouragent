import React from "react";

const STORAGE_KEY = "ccfr-sidebar-collapsed";

function getInitial(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useCollapsed() {
  const [collapsed, setCollapsed] = React.useState<boolean>(getInitial);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  const toggle = React.useCallback(() => setCollapsed((c) => !c), []);

  return { collapsed, toggle };
}
