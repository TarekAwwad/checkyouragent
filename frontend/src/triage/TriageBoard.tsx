import React from "react";
import type { SessionCard } from "../api/types";
import { Blurred } from "../shell/Blurred";
import LoadingBar from "../components/LoadingBar";
import InsightStat from "../components/InsightStat";
import PageHeader from "../shell/PageHeader";
import SearchField from "../components/controls/SearchField";
import ToggleChip from "../components/controls/ToggleChip";
import FilterSelect from "../components/controls/FilterSelect";
import { useAnalysisScope } from "../shell/analysisScope";
import { instantBounds, overlapsWindow } from "../shell/dateRange";
import type { SessionSortKey, SessionsViewState } from "../shell/investigationState";

interface Props {
  sessions: SessionCard[];
  loading: boolean;
  onOpenSession: (session: SessionCard) => void;
  memory?: React.MutableRefObject<SessionsViewState>;
}

type SortKey = SessionSortKey;

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: "first_ts", label: "Newest first" },
  { key: "last_ts", label: "Recently ended" },
  { key: "cost_usd", label: "Highest estimated API-equivalent cost" },
  { key: "error_count", label: "Most observed errors" },
  { key: "finding_count", label: "Supported finding" },
  { key: "event_count", label: "Highest event volume" },
  { key: "subagent_count", label: "Most subagents" },
];

function sortValue(session: SessionCard, sortKey: SortKey): number {
  if (sortKey === "first_ts" || sortKey === "last_ts") {
    const value = sortKey === "first_ts" ? session.first_ts : session.last_ts;
    const timestamp = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }
  return session[sortKey] as number;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function formatBasis(value: SessionCard["top_finding_basis"]): string | null {
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function supportedFinding(session: SessionCard): { title: string; detail: string; tone: "finding" | "calm" } {
  if (session.finding_count > 0) {
    const basis = formatBasis(session.top_finding_basis);
    const count = `${session.finding_count} finding${session.finding_count === 1 ? "" : "s"}`;
    return {
      title: session.top_finding_title || "Supported finding detected",
      detail: basis ? `${basis} · ${count}` : count,
      tone: "finding",
    };
  }
  return { title: "No supported finding detected", detail: "", tone: "calm" };
}

function TriageBoard({ sessions, loading, onOpenSession, memory }: Props) {
  const { resolvedRange, projectId } = useAnalysisScope();
  const [query, setQuery] = React.useState(() => memory?.current.query ?? "");
  const [onlyErrors, setOnlyErrors] = React.useState(() => memory?.current.onlyErrors ?? false);
  const [sortKey, setSortKey] = React.useState<SortKey>(() => memory?.current.sortKey ?? "first_ts");
  const tableRef = React.useRef<HTMLDivElement>(null);
  const restoredScroll = React.useRef(false);

  React.useLayoutEffect(() => {
    if (memory) memory.current = { ...memory.current, query, onlyErrors, sortKey };
  }, [memory, query, onlyErrors, sortKey]);
  React.useLayoutEffect(() => {
    if (!loading && !restoredScroll.current && tableRef.current) {
      tableRef.current.scrollTop = memory?.current.scrollTop ?? 0;
      restoredScroll.current = true;
    }
  }, [loading, memory]);

  const { from, to } = resolvedRange;
  const bounds = React.useMemo(() => instantBounds({ from, to }), [from, to]);

  const rows = React.useMemo(() => {
    const filtered = sessions.filter((session) => {
      if (projectId !== null && session.project_id !== projectId) return false;
      // Same rule as Cost: any activity inside the range counts.
      if (!overlapsWindow(session.first_ts, session.last_ts, bounds)) return false;
      if (onlyErrors && session.error_count === 0) return false;
      if (query) {
        const hay = `${session.title ?? ""} ${session.session_id} ${session.cwd ?? ""} ${session.project_name}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
  }, [sessions, projectId, bounds, onlyErrors, query, sortKey]);

  const totalCost = rows.reduce((sum, session) => sum + session.cost_usd, 0);
  const costAvailable = rows.some((session) => session.cost_available);
  const observedErrorCount = rows.reduce((sum, session) => sum + session.error_count, 0);

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
      <PageHeader
        title="Sessions"
        subtitle="Recorded sessions."
        scope={{ date: "filter", project: "filter" }}
        filters={(
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Search sessions" />
            <ToggleChip label="Errors only" checked={onlyErrors} onChange={setOnlyErrors} />
          </>
        )}
        view={(
          <FilterSelect label="Sort sessions" value={sortKey} onChange={(value) => setSortKey(value as SortKey)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </FilterSelect>
        )}
      />

      <div className="cost-insight-strip" aria-label="Session totals">
        <InsightStat label="Sessions" value={rows.length.toLocaleString()} />
        <InsightStat label="Estimated API-equivalent cost" value={costAvailable ? formatUsd(totalCost) : "—"} />
        <InsightStat label="Observed errors" value={observedErrorCount.toLocaleString()} />
      </div>

      <section className="card triage-card">
        <div
          ref={tableRef}
          className="triage-table-wrap"
          onScroll={(event) => {
            if (memory && restoredScroll.current) memory.current.scrollTop = event.currentTarget.scrollTop;
          }}
        >
          {loading ? (
            <div className="empty-state"><LoadingBar caption="Loading sessions…" /></div>
          ) : rows.length === 0 ? (
            <div className="empty-state">No sessions match the current filters.</div>
          ) : (
            <table className="triage-table">
              <thead>
                <tr>
                  <th>Session</th>
                  {header("first_ts", "Started")}
                  {header("last_ts", "Ended")}
                  {header("finding_count", "Supported finding")}
                  <th>Impact</th>
                  {header("cost_usd", "Cost")}
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {rows.map((session) => {
                  const finding = supportedFinding(session);
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
                        <div className="tr-name"><Blurred>{session.title || session.session_id.slice(0, 8)}</Blurred></div>
                        <div className="tr-sub"><Blurred>{session.project_name}{session.title ? ` · ${session.session_id.slice(0, 8)}` : ""}</Blurred></div>
                      </td>
                      <td className="cell-started">
                        {session.first_ts ? (
                          <time dateTime={session.first_ts}>{formatTimestamp(session.first_ts)}</time>
                        ) : "—"}
                      </td>
                      <td className="cell-ended">
                        {session.last_ts ? (
                          <time dateTime={session.last_ts}>{formatTimestamp(session.last_ts)}</time>
                        ) : "—"}
                      </td>
                      <td className={`cell-issue issue-${finding.tone}`}>
                        <span className="finding-cell">
                          <Blurred>{finding.title}</Blurred>
                        </span>
                        {finding.detail && <small>{finding.detail}</small>}
                      </td>
                      <td className="cell-impact">
                        <div className="impact-stack" aria-label="Session impact">
                          {session.error_count > 0 && <span className="impact-chip err">{session.error_count} errors</span>}
                          {session.subagent_count > 0 && (
                            <span className="impact-chip neutral">
                              {session.subagent_count} subagent{session.subagent_count === 1 ? "" : "s"}
                            </span>
                          )}
                          <span className="impact-chip neutral">{session.event_count.toLocaleString()} events</span>
                        </div>
                        <div className="vol-dur">{Math.round(session.duration_seconds / 60)} min</div>
                      </td>
                      <td className={session.cost_available && session.cost_usd > 0 ? "cell-cost" : "cell-muted"}>
                        {session.cost_available ? formatUsd(session.cost_usd) : "—"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="triage-action"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenSession(session);
                          }}
                        >
                          Investigate
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

export default TriageBoard;
