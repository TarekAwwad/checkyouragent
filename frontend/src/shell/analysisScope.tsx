import React from "react";
import {
  ALL_TIME, defaultPreset, presetRange, type DateRange, type ResolvedRange,
} from "./dateRange";

export interface ProjectOption {
  id: number;
  name: string;
}

/** What a data scope's dataset says about recency, once it has loaded. */
export interface ScopeSignal {
  populated: boolean;
  latestDay: string | null;
}

export interface ScopeSlot {
  range: DateRange;
  projectId: number | null;
  /** True until the user picks a range; only an automatic range is re-evaluated. */
  rangeIsAutomatic: boolean;
  /** True once a page has displayed the range; a shown range is never switched automatically. */
  rangeShown: boolean;
  /**
   * False until the first data signal. An unresolved slot (startup, or right
   * after a reset) holds no context yet: its first data decides the range,
   * replacing any earlier choice.
   */
  resolved: boolean;
  populated: boolean | null;
}

export const UNRESOLVED_SLOT: ScopeSlot = {
  range: ALL_TIME, projectId: null, rangeIsAutomatic: true, rangeShown: false, resolved: false, populated: null,
};

export type ScopeAction =
  | { type: "data"; signal: ScopeSignal; today: string }
  | { type: "reset" }
  | { type: "setRange"; range: DateRange }
  | { type: "setProject"; projectId: number | null }
  | { type: "markShown" };

export function scopeReducer(slot: ScopeSlot, action: ScopeAction): ScopeSlot {
  switch (action.type) {
    case "data": {
      const { populated, latestDay } = action.signal;
      const firstData = slot.populated === false && populated;
      if (!slot.resolved || (slot.rangeIsAutomatic && !slot.rangeShown && firstData)) {
        return {
          ...slot,
          range: presetRange(defaultPreset(latestDay, action.today)),
          rangeIsAutomatic: true,
          resolved: true,
          populated,
        };
      }
      return slot.populated === populated ? slot : { ...slot, populated };
    }
    case "reset":
      return UNRESOLVED_SLOT;
    case "setRange":
      return { ...slot, range: action.range, rangeIsAutomatic: false };
    case "setProject":
      return slot.projectId === action.projectId ? slot : { ...slot, projectId: action.projectId };
    case "markShown":
      return slot.rangeShown ? slot : { ...slot, rangeShown: true };
  }
}

export interface AnalysisScopeValue {
  range: DateRange;
  resolvedRange: ResolvedRange;
  projectId: number | null;
  projects: ProjectOption[];
  setRange: (range: DateRange) => void;
  setProjectId: (projectId: number | null) => void;
  markRangeShown: () => void;
}

export const AnalysisScopeContext = React.createContext<AnalysisScopeValue | null>(null);

export function useAnalysisScope(): AnalysisScopeValue {
  const value = React.useContext(AnalysisScopeContext);
  if (!value) throw new Error("useAnalysisScope needs an AnalysisScopeContext provider.");
  return value;
}
