import React from "react";
import type { View } from "./navConfig";
import type { DataScope } from "./useDataScope";

export type AnalyticalView = Extract<View, "cost" | "map" | "discover">;

export function isAnalyticalView(view: View | null, scope: DataScope): view is AnalyticalView {
  return view === "cost" || view === "map" || (view === "discover" && scope === "local");
}

export function rememberedLanding(scope: DataScope): AnalyticalView {
  try {
    const stored = localStorage.getItem(`ccfr.lastAnalyticalPage.${scope}`) as View | null;
    return isAnalyticalView(stored, scope) ? stored : "cost";
  } catch {
    return "cost";
  }
}

export function initialHashView(scope: DataScope): View | null {
  const hash = window.location.hash;
  if (hash === "#cost") return "cost";
  if (hash === "#sessions" || hash === "#overview") return "map";
  if (hash === "#sources" || hash === "#import" || hash === "#bundles") return "import";
  if (scope === "local") {
    if (hash === "#explore") return "discover";
    if (hash === "#share" || hash === "#export") return "export";
    if (/^#session\/\d+$/.test(hash)) return "session";
  }
  return null;
}

/** Resolve onboarding once per scope visit; later imports do not navigate away
 * from the results. Only analytical pages are remembered for the next visit. */
export function useLandingPage(scope: DataScope, hasData: boolean | undefined) {
  const [navigation, setNavigation] = React.useState<{ scope: DataScope; view: View | null }>(
    () => ({ scope, view: initialHashView(scope) }),
  );
  const view = navigation.scope === scope ? navigation.view : null;

  React.useEffect(() => {
    if (view !== null || hasData === undefined) return;
    setNavigation({ scope, view: hasData ? rememberedLanding(scope) : "import" });
  }, [scope, view, hasData]);

  React.useEffect(() => {
    if (!isAnalyticalView(view, scope)) return;
    try {
      localStorage.setItem(`ccfr.lastAnalyticalPage.${scope}`, view);
    } catch {
      // Navigation also works when browser storage is disabled.
    }
  }, [view, scope]);

  const setView = React.useCallback((next: View) => setNavigation({ scope, view: next }), [scope]);
  return { view, setView };
}
