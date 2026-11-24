import React from "react";
import type { UsageCharacteristicsResponse } from "../../api/types";
import { formatTokens, formatUsd } from "../../analytics/chartGeometry";
import InsightStat from "../../components/InsightStat";
import LoadingBar from "../../components/LoadingBar";
import { Blurred } from "../../shell/Blurred";
import { formatShare, useUsageCharacteristics } from "./driverData";
import PageHeader from "../../shell/PageHeader";
import { useAnalysisScope } from "../../shell/analysisScope";
import { instantBounds } from "../../shell/dateRange";

// Explore technique: the overlapping traits behind your usage (/usage's
// "what's contributing" panel), each with its share of the window's total.
// What each driver means, and its advice, is in the glossary.
export default function UsageDrivers() {
  const { resolvedRange, projectId, projects } = useAnalysisScope();
  const { from, to } = resolvedRange;
  const bounds = React.useMemo(() => instantBounds({ from, to }), [from, to]);
  const query = useUsageCharacteristics(projectId, bounds);
  const data = query.data;
  const project = projects.find((p) => p.id === projectId);
  const basis = data?.meta.share_basis === "tokens" ? "tokens" : "cost";
  const updating = query.isFetching && !query.isPending;

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <PageHeader
          section="Explore"
          title="Usage drivers"
          subtitle={<>Share of {basis}, {project ? <Blurred>{project.name}</Blurred> : "all projects"}.</>}
          status={updating ? "Updating…" : null}
          scope={{ date: "filter", project: "filter" }}
        />

        {query.isPending && (
          <div className="loading-view"><LoadingBar caption="Loading usage drivers…" /></div>
        )}
        {query.isError && !data && (
          <div className="empty-state panel-error">
            <strong>Failed to load</strong>
            <span>Usage drivers could not be loaded.</span>
          </div>
        )}
        {data && <DriversView data={data} />}
      </div>
    </main>
  );
}

function DriversView({ data }: { data: UsageCharacteristicsResponse }) {
  const { meta, characteristics } = data;
  const byCost = meta.share_basis === "cost";
  const empty = meta.sessions_analyzed === 0;
  const count = characteristics.length;

  return (
    <>
      {!meta.cost_available && (
        <p className="tile-note">No price table: tokens only.</p>
      )}
      {meta.cost_available && meta.costs_partial && (
        <p className="tile-note">Some models are unpriced: costs are a lower bound.</p>
      )}
      <div className="cost-insight-strip" aria-label="Usage totals">
        <InsightStat label="Cost" value={meta.cost_available ? formatUsd(meta.total_usd) : "—"} />
        <InsightStat label="Sessions" value={meta.sessions_analyzed.toLocaleString("en-US")} />
        <InsightStat label="Tokens" value={formatTokens(meta.total_tokens)} />
      </div>
      <section className="card" aria-label="Share of usage">
        <div className="card-head">
          <h2>Share of usage</h2>
          {!empty && (
            <span className="card-count"><b>{count}</b> {count === 1 ? "driver" : "drivers"}</span>
          )}
        </div>
        <div className="card-pad">
          {empty ? (
            <div className="empty-state">No usage in this window.</div>
          ) : (
            <div className="usage-drivers-rows" role="list" aria-label="Usage drivers">
              {characteristics.map((c) => (
                <div key={c.key} className="cbm-row" role="listitem">
                  <div className="cbm-label">{c.label}</div>
                  {/* The track is 100% of the window's usage, not the largest
                      row: drivers overlap, so they are not slices of a whole. */}
                  <div className="cbm-track" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, Math.max(0, c.share * 100))}%` }} />
                  </div>
                  <div className="cbm-val">
                    <b>{formatShare(c.share)}</b>
                    <span>{byCost ? formatUsd(c.cost_usd) : `${formatTokens(c.tokens)} tok`}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
