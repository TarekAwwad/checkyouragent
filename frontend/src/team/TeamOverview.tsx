import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { getTeamDashboard } from "../api/client";
import { compactInt } from "./bundlePresentation";
import { buildAreaChart } from "./teamCharts";
import PageHeader from "../shell/PageHeader";
import InsightStat from "../components/InsightStat";
import LoadingBar from "../components/LoadingBar";

const CHART_W = 600;
const CHART_H = 130;

function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function countLabel(value: number, singular: string): string {
  return `${compactInt(value)} ${singular}${value === 1 ? "" : "s"}`;
}

interface Props {
  onGoToImport: () => void;
}

// The team-scope "Overview": the same aggregate story the local Sessions view tells,
// but computed on the backend from imported team bundles. No per-session detail
// exists in a bundle, so there is nothing to drill into here by design.
function OverviewHeader() {
  return (
    <PageHeader
      title="Overview"
      subtitle="Aggregated usage across imported team bundles — no prompts, file contents, or commands."
      scope={{ date: "fixed", project: "fixed" }}
    />
  );
}

export default function TeamOverview({ onGoToImport }: Props) {
  const dashboard = useQuery({ queryKey: ["team-dashboard"], queryFn: getTeamDashboard });

  if (dashboard.isLoading) {
    return (
      <main className="page team-flow-page team-overview-page">
        <OverviewHeader />
        <div className="loading-view"><LoadingBar caption="Loading team overview…" /></div>
      </main>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <main className="page team-flow-page team-overview-page">
        <OverviewHeader />
        <div className="team-state panel-error">
          <strong>Team overview unavailable.</strong>
          <span>Could not load the aggregated team dashboard.</span>
        </div>
      </main>
    );
  }

  const summary = dashboard.data;
  const meta = summary.meta;
  const sessionCount = meta?.session_count ?? 0;

  if (sessionCount === 0) {
    return (
      <main className="page team-flow-page team-overview-page">
        <OverviewHeader />
        <div className="team-empty card">
          <strong>No team bundles imported yet.</strong>
          <p>Import a team bundle to see aggregated activity and reliability summaries.</p>
          <button type="button" className="team-primary-button" onClick={onGoToImport}>
            <ArrowRight size={15} aria-hidden="true" /> Go to Import
          </button>
        </div>
      </main>
    );
  }

  const tokens = summary.tokens;
  const stats = summary.stats;
  const reliability = summary.reliability ?? {
    error_count: stats?.errors ?? 0,
    session_count: sessionCount,
    errors_per_session: sessionCount > 0 ? (stats?.errors ?? 0) / sessionCount : 0,
  };
  const models = summary.models ?? [];
  const members = summary.members ?? [];
  const projects = summary.projects ?? [];
  const tools = summary.tools ?? [];
  const fileTypes = summary.file_types ?? [];
  const memberRows = [...members].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  const projectRows = [...projects].slice(0, 8); // backend already sorts by tokens desc
  const memberMax = Math.max(...memberRows.map((m) => m.tokens), 1);
  const projectMax = Math.max(...projectRows.map((p) => p.tokens), 1);
  const toolMax = Math.max(...tools.slice(0, 8).map((t) => t.call_count), 1);
  const fileTypeMax = Math.max(...fileTypes.slice(0, 8).map((f) => f.count), 1);
  const overTime = summary.over_time ?? [];
  const activity = buildAreaChart(overTime.map((p) => ({ label: p.date, value: p.tokens })), CHART_W, CHART_H);
  const reliabilityRows = [...members].sort((a, b) => a.member_name.localeCompare(b.member_name));
  const reliabilityMax = Math.max(...reliabilityRows.map((member) => member.errors_per_session), 0);
  const modelMax = Math.max(...models.map((model) => model.tokens), 0);

  return (
    <main className="page team-flow-page team-overview-page">
      <OverviewHeader />
      <div className="cost-insight-strip" aria-label="Team totals">
        <InsightStat label="Members" value={compactInt(meta?.member_count ?? 0)} />
        <InsightStat label="Projects" value={compactInt(meta?.project_count ?? 0)} />
        <InsightStat label="Sessions" value={compactInt(sessionCount)} />
        <InsightStat label="Tokens" value={compactInt(tokens?.total ?? 0)} />
      </div>

      <section className="team-overview-body" aria-label="Team overview workspace">
        <section className="team-dashboard-strip" aria-label="Team totals detail">
          <div>
            <span>Token totals</span>
            <strong>{compactInt(tokens?.input ?? 0)} in / {compactInt(tokens?.output ?? 0)} out</strong>
          </div>
          <div>
            <span>Recorded errors / session</span>
            <strong>{formatRate(reliability.errors_per_session)} per session</strong>
            <small>{countLabel(reliability.error_count, "error")} / {countLabel(reliability.session_count, "session")}</small>
          </div>
          <div>
            <span>Recorded tool calls</span>
            <strong>{compactInt(stats?.tool_calls ?? 0)}</strong>
          </div>
          <div>
            <span>Bundles</span>
            <strong>{compactInt(meta?.bundle_count ?? 0)}</strong>
          </div>
        </section>

        <div className="team-overview-board">
          {overTime.length > 0 ? (
            <section className="team-activity card" aria-labelledby="team-activity-title">
              <div className="team-card-head">
                <h2 id="team-activity-title">Token activity over time</h2>
                <span>
                  {meta?.date_from} → {meta?.date_to}
                </span>
              </div>
              <svg
                className="team-activity-svg"
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label="Token activity over time"
              >
                <path d={activity.areaPath} className="team-activity-area" />
                <path d={activity.linePath} className="team-activity-line" fill="none" vectorEffect="non-scaling-stroke" />
              </svg>
            </section>
          ) : null}

          <div className="team-breakdowns">
            <TeamBars
              title="Recorded errors per session"
              ariaLabel="Recorded errors per session by member"
              rows={reliabilityRows.map((member) => ({
                label: member.member_name,
                value: member.errors_per_session,
                valueLabel: formatRate(member.errors_per_session),
                detail: `${countLabel(member.error_count, "error")} / ${countLabel(member.session_count, "session")}`,
              }))}
              max={reliabilityMax}
              empty="No member-level reliability data recorded."
            />
            <TeamBars
              title="Model token mix"
              ariaLabel="Team model token mix"
              rows={models.map((model) => ({ label: model.model, value: model.tokens }))}
              max={modelMax}
              empty="No per-model token breakdown recorded."
            />
          </div>

          {(members.length > 0 || projectRows.length > 0) && (
            <div className="team-breakdowns">
              <TeamBars
                title="Token volume by member"
                ariaLabel="Token volume by member"
                rows={memberRows.map((m) => ({ label: m.member_name, value: m.tokens }))}
                max={memberMax}
                empty="No members yet."
              />
              <TeamBars
                title="Token volume by project"
                ariaLabel="Token volume by project"
                rows={projectRows.map((p) => ({ label: p.project_name, value: p.tokens }))}
                max={projectMax}
                empty="No projects yet."
              />
            </div>
          )}
          {(tools.length > 0 || fileTypes.length > 0) && (
            <div className="team-breakdowns">
              <TeamBars
                title="Toolchain"
                ariaLabel="Team toolchain"
                rows={tools.slice(0, 8).map((t) => ({ label: t.name, value: t.call_count }))}
                max={toolMax}
                empty="Tool names appear once team-level bundles are imported."
              />
              <TeamBars
                title="File types"
                ariaLabel="Team file types"
                rows={fileTypes.slice(0, 8).map((f) => ({ label: `.${f.ext}`, value: f.count }))}
                max={fileTypeMax}
                empty="File types appear once team-level bundles are imported."
              />
            </div>
          )}

        </div>
      </section>
    </main>
  );
}

function TeamBars({
  title,
  ariaLabel,
  rows,
  max,
  empty,
}: {
  title: string;
  ariaLabel: string;
  rows: { label: string; value: number; valueLabel?: string; detail?: string }[];
  max: number;
  empty: string;
}) {
  return (
    <section className="team-bars card" aria-label={ariaLabel}>
      <div className="team-card-head">
        <h2>{title}</h2>
      </div>
      {rows.length > 0 ? (
        <div className="team-bar-rows">
          {rows.map((row) => (
            <div className="team-bar-row" key={row.label}>
              <span className="team-bar-copy">
                <span className="team-bar-label" title={row.label}>{row.label}</span>
                {row.detail && <small>{row.detail}</small>}
              </span>
              <span className="team-bar-track">
                <i style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }} />
              </span>
              <span className="team-bar-val">{row.valueLabel ?? compactInt(row.value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
