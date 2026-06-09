import React from "react";
import { AlertTriangle, Filter, Network, Search } from "lucide-react";
import type { Project, SessionCard } from "../api/types";
import { riskScore } from "./riskScore";
import RiskCell from "./RiskCell";

interface Props {
  projects: Project[];
  sessions: SessionCard[];
  loading: boolean;
  onOpenSession: (session: SessionCard) => void;
}

type SortKey = "risk" | "patterns" | "error_count" | "max_repeat" | "subagent_count" | "event_count" | "cost_usd";

function sortValue(session: SessionCard, sortKey: SortKey): number {
  if (sortKey === "risk") return riskScore(session);
  if (sortKey === "patterns") return session.pattern_risk_score;
  return session[sortKey] as number;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatCategory(value: string | null): string {
  if (!value) return "No findings";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function TriageBoard({ projects, sessions, loading, onOpenSession }: Props) {
  const [query, setQuery] = React.useState("");
  const [projectId, setProjectId] = React.useState<number | "all" | null>(null);
  const [onlyErrors, setOnlyErrors] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<SortKey>("risk");

  const activeProjectId = React.useMemo<number | "all">(() => {
    if (projectId === null) return projects[0]?.id ?? "all";
    if (projectId === "all") return projectId;
    return projects.some((project) => project.id === projectId) ? projectId : (projects[0]?.id ?? "all");
  }, [projectId, projects]);

  const rows = React.useMemo(() => {
    const filtered = sessions.filter((session) => {
      if (activeProjectId !== "all" && session.project_id !== activeProjectId) return false;
      if (onlyErrors && session.error_count === 0) return false;
      if (query) {
        const hay = `${session.title ?? ""} ${session.session_id} ${session.cwd ?? ""} ${session.project_name}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
  }, [sessions, activeProjectId, onlyErrors, query, sortKey]);

  const projectLabel = activeProjectId === "all"
    ? "All projects"
    : projects.find((project) => project.id === activeProjectId)?.display_name ?? "Project";
  const totalCost = rows.reduce((sum, session) => sum + session.cost_usd, 0);
  const costAvailable = rows.some((session) => session.cost_available);

  const header = (key: SortKey, label: string) => (
    <th
      onClick={() => setSortKey(key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSortKey(key);
        }
      }}
      tabIndex={0}
      aria-sort={sortKey === key ? "descending" : "none"}
      className={sortKey === key ? "sorted" : ""}
    >
      {label}
    </th>
  );

  return (
    <main className="page triage-page">
      <section className="triage-head">
        <h1>Triage Board <span className="count">{rows.length.toLocaleString()} sessions</span></h1>
        <label className="searchbox">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions" />
        </label>
      </section>

      <section className="card triage-card">
        <div className="triage-toolbar">
          <label className="selectbox">
            <Filter size={15} />
            <select value={activeProjectId} onChange={(e) => setProjectId(e.target.value === "all" ? "all" : Number(e.target.value))}>
              <option value="all">All projects</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.display_name}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
            <span>Errors only</span>
          </label>
        </div>
        <div className="triage-project-summary" aria-label="Project cost summary">
          <span className="tps-project">{projectLabel}</span>
          <span className="tps-sessions">{rows.length.toLocaleString()} sessions</span>
          <span className="tps-cost">
            {costAvailable ? <>Total cost <b>{formatUsd(totalCost)}</b></> : "Cost unavailable"}
          </span>
        </div>
        <div className="triage-table-wrap">
          {loading ? (
            <div className="empty-state">Loading sessions...</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">No sessions match the current filters.</div>
          ) : (
            <table className="triage-table">
              <thead>
                <tr>
                  {header("risk", "Risk")}
                  <th>Session</th>
                  {header("patterns", "Findings")}
                  {header("error_count", "Errors")}
                  {header("max_repeat", "Loops")}
                  {header("subagent_count", "Fanout")}
                  {header("event_count", "Volume")}
                  {header("cost_usd", "Cost")}
                </tr>
              </thead>
              <tbody>
                {rows.map((session) => {
                  return (
                    <tr
                      key={session.id}
                      onClick={() => onOpenSession(session)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onOpenSession(session);
                      }}
                      tabIndex={0}
                      className="triage-row"
                    >
                      <td>
                        <RiskCell session={session} />
                      </td>
                      <td>
                        <div className="tr-name">{session.title || session.session_id.slice(0, 8)}</div>
                        <div className="tr-sub">{session.project_name}{session.title ? ` · ${session.session_id.slice(0, 8)}` : ""}</div>
                      </td>
                      <td className={session.finding_count ? "cell-findings" : "cell-muted"}>
                        {session.finding_count ? (
                          <span className="finding-cell">
                            {session.top_finding_title || formatCategory(session.top_finding_category)}
                          </span>
                        ) : "none"}
                      </td>
                      <td className={session.error_count ? "cell-err" : "cell-muted"}>{session.error_count}</td>
                      <td className={session.loop_count ? "cell-loop" : "cell-muted"}>
                        {session.loop_count ? `×${session.max_repeat}` : "—"}
                      </td>
                      <td className={session.subagent_count ? "cell-fan" : "cell-muted"}>{session.subagent_count}</td>
                      <td className="cell-vol">
                        <div><b>{session.event_count.toLocaleString()}</b> events</div>
                        <div className="vol-dur">{Math.round(session.duration_seconds / 60)} min</div>
                      </td>
                      <td className={session.cost_available && session.cost_usd > 0 ? "cell-cost" : "cell-muted"}>
                        {session.cost_available ? formatUsd(session.cost_usd) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="map-footer">
        <span><Network size={16} /> {rows.length.toLocaleString()} sessions</span>
        <span>
          <AlertTriangle size={16} /> {rows.reduce((sum, session) => sum + session.error_count + session.system_count, 0).toLocaleString()} alert events
          ({rows.reduce((sum, session) => sum + session.error_count, 0).toLocaleString()} errors,
          {" "}
          {rows.reduce((sum, session) => sum + session.system_count, 0).toLocaleString()} system)
        </span>
      </section>
    </main>
  );
}

export default TriageBoard;
