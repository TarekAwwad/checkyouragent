import React from "react";
import { ALL_TIME, localIsoDate, resolveRange, type DateRange } from "./dateRange";
import { AnalysisScopeContext, type AnalysisScopeValue, type ProjectOption } from "./analysisScope";

const NO_PROJECTS: ProjectOption[] = [];

interface Props {
  children: React.ReactNode;
  range?: DateRange;
  projectId?: number | null;
  projects?: ProjectOption[];
  /** Local YYYY-MM-DD the presets resolve against; defaults to the real today. */
  today?: string;
}

/** Tests only: a working scope provider without the app's data wiring. */
export function TestScopeProvider({
  children, range: initialRange = ALL_TIME, projectId: initialProjectId = null,
  projects = NO_PROJECTS, today,
}: Props) {
  const [range, setRange] = React.useState<DateRange>(initialRange);
  const [projectId, setProjectId] = React.useState<number | null>(initialProjectId);
  const day = today ?? localIsoDate(new Date());
  const markRangeShown = React.useCallback(() => {}, []);
  const value = React.useMemo<AnalysisScopeValue>(() => ({
    range, resolvedRange: resolveRange(range, day), projectId, projects, setRange, setProjectId,
    markRangeShown,
  }), [range, day, projectId, projects, markRangeShown]);
  return <AnalysisScopeContext.Provider value={value}>{children}</AnalysisScopeContext.Provider>;
}
