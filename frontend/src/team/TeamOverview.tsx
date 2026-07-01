import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { getTeamDashboard } from "../api/client";
import { compactInt, prettySymbol } from "../contribute/specimen";
import { buildAreaChart } from "./teamCharts";

const CHART_W = 600;
const CHART_H = 130;

function prettyRisk(category: string): string {
  return category.replace(/_/g, " ");
}

interface Props {
  onGoToImport: () => void;
}

// The team-scope "Overview": the same aggregate story the local Overview tells,
// but computed on the backend from imported team bundles. No per-session detail
// exists in a bundle, so there is nothing to drill into here by design.
export default function TeamOverview({ onGoToImport }: Props) {
  const dashboard = useQuery({ queryKey: ["team-dashboard"], queryFn: getTeamDashboard });

  if (dashboard.isLoading) {
    return (
      <main className="page contribute-page team-page">
        <div className="contribute-state">Loading team overview…</div>
      </main>
    );
  }

  if (dashboard.isError || !dashboard.data) {
    return (
      <main className="page contribute-page team-page">
        <div className="contribute-state panel-error">
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
      <main className="page contribute-page team-page">
        <Header />
        <div className="team-empty card">
          <strong>No team bundles imported yet.</strong>
          <p>Import a team bundle to see aggregated usage, risk patterns, and activity.</p>
          <button type="button" className="contribute-primary-button" onClick={onGoToImport}>
            <ArrowRight size={15} aria-hidden="true" /> Go to Import
          </button>
        </div>
      </main>
    );
  }

  const tokens = summary.tokens;
  const stats = summary.stats;
  const risks = summary.risk_categories ?? [];
  const models = summary.models ?? [];
  const symbols = (summary.sequence ?? []).slice(0, 8);
  const overTime = summary.over_time ?? [];
  const activity = buildAreaChart(overTime.map((p) => ({ label: p.date, value: p.tokens })), CHART_W, CHART_H);
  const riskMax = Math.max(...risks.map((r) => r.session_count), 1);
  const modelMax = Math.max(...models.map((m) => m.session_count), 1);

  return (
    <main className="page contribute-page team-page">
      <Header>
        <div className="contribute-metrics team-metrics" aria-label="Team totals">
          <Metric value={meta?.member_count ?? 0} label="Members" />
          <Metric value={meta?.project_count ?? 0} label="Projects" />
          <Metric value={sessionCount} label="Sessions" />
          <Metric value={tokens?.total ?? 0} label="Tokens" />
        </div>
      </Header>

      <section className="team-dashboard-strip" aria-label="Team totals detail">
        <div>
          <span>Token totals</span>
          <strong>{compactInt(tokens?.input ?? 0)} in / {compactInt(tokens?.output ?? 0)} out</strong>
        </div>
        <div>
          <span>Errors</span>
          <strong>{compactInt(stats?.errors ?? 0)}</strong>
        </div>
        <div>
          <span>Loops</span>
          <strong>{compactInt(stats?.loops ?? 0)}</strong>
        </div>
        <div>
          <span>Bundles</span>
          <strong>{compactInt(meta?.bundle_count ?? 0)}</strong>
        </div>
      </section>

      {overTime.length > 0 ? (
        <section className="team-activity card" aria-labelledby="team-activity-title">
          <div className="team-symbols-head">
            <h2 id="team-activity-title">Activity over time</h2>
            <span>
              {meta?.date_from} → {meta?.date_to}
            </span>
          </div>
          <svg
            className="team-activity-svg"
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Activity over time"
          >
            <path d={activity.areaPath} className="team-activity-area" />
            <path d={activity.linePath} className="team-activity-line" fill="none" vectorEffect="non-scaling-stroke" />
          </svg>
        </section>
      ) : null}

      <div className="team-breakdowns">
        <TeamBars
          title="Risk patterns"
          ariaLabel="Team risk patterns"
          rows={risks.map((r) => ({ label: prettyRisk(r.category), value: r.session_count }))}
          max={riskMax}
          empty="No risk findings across team bundles."
        />
        <TeamBars
          title="Model mix"
          ariaLabel="Team model mix"
          rows={models.map((m) => ({ label: m.model, value: m.session_count }))}
          max={modelMax}
          empty="No models recorded."
        />
      </div>

      <section className="team-symbols" aria-labelledby="team-symbols-title">
        <div className="team-symbols-head">
          <h2 id="team-symbols-title">Top sequence symbols</h2>
          <span>{compactInt(meta?.bundle_count ?? 0)} imported bundles</span>
        </div>
        {symbols.length > 0 ? (
          <ol className="seq-strand">
            {symbols.map(({ sym, count }) => {
              const { label, kind } = prettySymbol(sym);
              return (
                <li className={`seq-chip k-${kind}`} key={sym} title={sym}>
                  {label} <em>x{compactInt(count)}</em>
                </li>
              );
            })}
          </ol>
        ) : (
          <p>No sequence symbols yet.</p>
        )}
      </section>
    </main>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <section className="contribute-header" aria-labelledby="team-title">
      <div className="contribute-titleblock team-titleblock">
        <h1 id="team-title">Team overview</h1>
        <p>Aggregated usage across imported team bundles — no prompts, file contents, or commands.</p>
      </div>
      {children}
    </section>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="contribute-metric">
      <strong>{compactInt(value)}</strong>
      <span>{label}</span>
    </div>
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
  rows: { label: string; value: number }[];
  max: number;
  empty: string;
}) {
  return (
    <section className="team-bars card" aria-label={ariaLabel}>
      <div className="team-symbols-head">
        <h2>{title}</h2>
      </div>
      {rows.length > 0 ? (
        <div className="team-bar-rows">
          {rows.map((row) => (
            <div className="team-bar-row" key={row.label}>
              <span className="team-bar-label" title={row.label}>
                {row.label}
              </span>
              <span className="team-bar-track">
                <i style={{ width: `${(row.value / max) * 100}%` }} />
              </span>
              <span className="team-bar-val">{compactInt(row.value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
