import React from "react";
import type { DataScope } from "./useDataScope";
import { resolveRange, type DateRange } from "./dateRange";
import { useLocalDay } from "./useLocalDay";
import {
  UNRESOLVED_SLOT, scopeReducer,
  type AnalysisScopeValue, type ProjectOption, type ScopeAction, type ScopeSignal, type ScopeSlot,
} from "./analysisScope";

type Slots = Record<DataScope, ScopeSlot>;

function storeReducer(slots: Slots, { scope, action }: { scope: DataScope; action: ScopeAction }): Slots {
  const next = scopeReducer(slots[scope], action);
  return next === slots[scope] ? slots : { ...slots, [scope]: next };
}

interface Options {
  scope: DataScope;
  /** Recency of each scope's dataset once loaded; null while loading. */
  signals: Record<DataScope, ScopeSignal | null>;
  /** Bumped by the app when a scope's investigation context resets. */
  epochs: Record<DataScope, number>;
  /** Projects selectable in the active scope. */
  projects: ProjectOption[];
  /** True when `projects` is authoritative, so a missing selection can be dropped. */
  projectsLoaded: boolean;
}

export function useScopeStore({ scope, signals, epochs, projects, projectsLoaded }: Options) {
  const today = useLocalDay();
  const [slots, dispatch] = React.useReducer(storeReducer, { local: UNRESOLVED_SLOT, team: UNRESOLVED_SLOT });
  const seenEpochs = React.useRef(epochs);

  React.useEffect(() => {
    for (const key of ["local", "team"] as const) {
      if (seenEpochs.current[key] !== epochs[key]) dispatch({ scope: key, action: { type: "reset" } });
    }
    seenEpochs.current = epochs;
  }, [epochs]);

  const localSignal = signals.local;
  const teamSignal = signals.team;
  const localResolved = slots.local.resolved;
  const teamResolved = slots.team.resolved;
  React.useEffect(() => {
    if (localSignal) dispatch({ scope: "local", action: { type: "data", signal: localSignal, today } });
  }, [localSignal, localResolved, today]);
  React.useEffect(() => {
    if (teamSignal) dispatch({ scope: "team", action: { type: "data", signal: teamSignal, today } });
  }, [teamSignal, teamResolved, today]);

  const slot = slots[scope];
  React.useEffect(() => {
    if (!projectsLoaded || slot.projectId === null) return;
    if (!projects.some((project) => project.id === slot.projectId)) {
      dispatch({ scope, action: { type: "setProject", projectId: null } });
    }
  }, [projectsLoaded, projects, slot.projectId, scope]);

  const setRange = React.useCallback(
    (range: DateRange) => dispatch({ scope, action: { type: "setRange", range } }), [scope]);
  const setProjectId = React.useCallback(
    (projectId: number | null) => dispatch({ scope, action: { type: "setProject", projectId } }), [scope]);
  const markRangeShown = React.useCallback(
    () => dispatch({ scope, action: { type: "markShown" } }), [scope]);
  const resolvedRange = React.useMemo(() => resolveRange(slot.range, today), [slot.range, today]);
  const value = React.useMemo<AnalysisScopeValue>(() => ({
    range: slot.range, resolvedRange, projectId: slot.projectId, projects, setRange, setProjectId, markRangeShown,
  }), [slot.range, resolvedRange, slot.projectId, projects, setRange, setProjectId, markRangeShown]);

  return { value, ready: slot.resolved };
}
