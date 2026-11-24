import React from "react";
import DateRangeControl from "../components/controls/DateRangeControl";
import ProjectSelect from "../components/controls/ProjectSelect";
import FixedChip from "../components/controls/FixedChip";
import { AnalysisScopeContext, type ProjectOption } from "./analysisScope";

export interface ScopeZone {
  date: "filter" | "fixed";
  project: "filter" | "fixed";
}

interface Props {
  title: React.ReactNode;
  section?: string;
  subtitle?: React.ReactNode;
  experimental?: boolean;
  status?: string | null;
  actions?: React.ReactNode;
  /** Before the title, e.g. the session page's Back control. */
  leading?: React.ReactNode;
  scope?: ScopeZone | null;
  /** Replaces the shared project list (Team Cost lists its own). */
  projectOptions?: ProjectOption[];
  /** Projects with activity in the current range, when the page knows them. */
  activeProjectIds?: number[];
  filters?: React.ReactNode;
  view?: React.ReactNode;
}

function ScopeControls({ zone, projectOptions, activeProjectIds }: {
  zone: ScopeZone;
  projectOptions?: ProjectOption[];
  activeProjectIds?: number[];
}) {
  const scope = React.useContext(AnalysisScopeContext);
  const showsRange = zone.date === "filter";
  const markRangeShown = scope?.markRangeShown;
  // A range on screen is never switched automatically (see analysisScope).
  React.useEffect(() => {
    if (showsRange) markRangeShown?.();
  }, [showsRange, markRangeShown]);
  if ((zone.date === "filter" || zone.project === "filter") && !scope) {
    throw new Error("PageHeader scope filters need an AnalysisScopeContext provider.");
  }
  return (
    <div className="page-header-zone" role="group" aria-label="Scope">
      {zone.date === "filter" && scope
        ? <DateRangeControl range={scope.range} resolved={scope.resolvedRange} onChange={scope.setRange} />
        : <FixedChip label="All time" className="fixed-chip-date" />}
      {zone.project === "filter" && scope
        ? <ProjectSelect value={scope.projectId} options={projectOptions ?? scope.projects}
                         activeIds={activeProjectIds} onChange={scope.setProjectId} />
        : <FixedChip label="All projects" className="fixed-chip-project" />}
    </div>
  );
}

export default function PageHeader({
  title, section, subtitle, experimental, status, actions, leading,
  scope, projectOptions, activeProjectIds, filters, view,
}: Props) {
  const hasControls = Boolean(scope) || Boolean(filters) || Boolean(view);
  return (
    <header className="page-header">
      <div className="page-header-row">
        {leading}
        <div className="page-header-identity">
          <div className="page-header-titleline">
            {section && (
              <>
                <span className="page-header-crumb">{section}</span>
                <span className="page-header-crumb-sep" aria-hidden="true">›</span>
              </>
            )}
            <h1 className="page-header-title">{title}</h1>
            {experimental && <span className="page-header-badge">Experimental</span>}
          </div>
          {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
        </div>
        <div className="page-header-aside">
          <span className="page-header-status" role="status">{status ?? ""}</span>
          {actions}
        </div>
      </div>
      {hasControls && (
        <div className="page-header-controls">
          {scope && (
            <ScopeControls zone={scope} projectOptions={projectOptions} activeProjectIds={activeProjectIds} />
          )}
          {filters && <div className="page-header-zone" role="group" aria-label="Filters">{filters}</div>}
          {view && <div className="page-header-zone" role="group" aria-label="View">{view}</div>}
        </div>
      )}
    </header>
  );
}
