import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getCostAnalytics, getTeamCostAnalytics } from "../api/client";
import type { CostAnalyticsFilters, SpendSpike } from "../api/types";
import type { DataScope } from "../shell/useDataScope";
import { buildModelColorMap, formatSignedUsd, formatTokens, formatUsd, largestSpike } from "./chartGeometry";
import FilterBar from "./FilterBar";
import CostByProject from "./CostByProject";
import SpendOverTime from "./SpendOverTime";
import TokenCategories from "./TokenCategories";
import CostByModel from "./CostByModel";
import InsightStrip from "./InsightStrip";
import LoadingBar from "../components/LoadingBar";
import SessionInsights, { TurnDistributionSection } from "./SessionInsights";
import { Blurred } from "../shell/Blurred";

interface Props {
  onOpenSession: (sessionId: number) => void;
  /** Whether historical (date-effective) pricing is active; drives the pricing-mode note. */
  historical?: boolean;
  /** In team scope, Cost is computed from imported bundles and the session-level
   * panels (which have no team equivalent) are hidden. Defaults to local. */
  scope?: DataScope;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

function SpikeSessionsPanel({
  spike,
  onOpenSession,
}: {
  spike: SpendSpike;
  onOpenSession: (sessionId: number) => void;
}) {
  const rows = React.useMemo(
    () => [...spike.sessions].sort((a, b) => b.usd - a.usd),
    [spike.sessions],
  );

  return (
    <section className="tile tile-full" aria-label={`Largest spike sessions for ${spike.bucket}`}>
      <h2>Largest spike sessions</h2>
      <p className="tile-note">
        {spike.bucket} - {formatSignedUsd(spike.delta_usd)} jump - {formatUsd(spike.total_usd)} total
      </p>
      {rows.length === 0 ? (
        <div className="empty-state">No sessions returned for this spike.</div>
      ) : (
        <ul className="discover-examples">
          {rows.map((session) => (
            <li key={session.id}>
              <div>
                <strong><Blurred>{session.title || session.session_id}</Blurred></strong>
                <span>
                  <Blurred>{session.project_name}</Blurred> - {formatTokens(session.tokens)} tokens - {formatUsd(session.usd)}
                </span>
              </div>
              <button type="button" onClick={() => onOpenSession(session.id)}>
                Open session
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function CostAnalyticsPage({ onOpenSession, historical = true, scope = "local" }: Props) {
  const isTeam = scope === "team";
  const [filters, setFilters] = React.useState<CostAnalyticsFilters>({ dateFrom: defaultFrom() });
  const [selectedSpikeBucket, setSelectedSpikeBucket] = React.useState<string | null>(null);

  // projectId/model are scope-namespaced (local ids vs team synthetic ids /
  // bucketed families); carrying them across a scope switch mis-filters the
  // other scope's data. Dates are scope-agnostic and survive the switch.
  React.useEffect(() => {
    setFilters((f) => (f.projectId || f.model ? { ...f, projectId: null, model: null } : f));
  }, [scope]);
  const query = useQuery({
    // `historical` and `scope` are part of the key so flipping the price mode or
    // the data scope is a distinct query (and request URL), not a same-URL
    // refetch that could be served stale from cache.
    queryKey: ["cost-analytics", scope, filters, historical],
    queryFn: () => (isTeam ? getTeamCostAnalytics(filters, historical) : getCostAnalytics(filters, historical)),
  });

  const payload = query.data;
  const errorMessage = query.error instanceof Error ? query.error.message : "Unable to load cost analytics.";
  const colors = React.useMemo(
    () => buildModelColorMap(payload?.meta.available_models ?? []),
    [payload?.meta.available_models],
  );
  const currentLargestSpike = React.useMemo(
    () => (payload ? largestSpike(payload) : null),
    [payload],
  );
  const selectedSpike = selectedSpikeBucket === currentLargestSpike?.bucket ? currentLargestSpike : null;

  React.useEffect(() => {
    if (selectedSpikeBucket !== null && selectedSpikeBucket !== currentLargestSpike?.bucket) {
      setSelectedSpikeBucket(null);
    }
  }, [currentLargestSpike?.bucket, selectedSpikeBucket]);

  return (
    <main className="cost-page">
      <div className="cost-page-inner">
        <FilterBar filters={filters} meta={payload?.meta} onChange={setFilters} />
        <p className="cost-pricing-note">
          {historical
            ? "Spend is priced at the rates in effect on each session's date. Toggle historical pricing in the sidebar to value everything at current rates."
            : "Spend is priced at current rates for every session. Toggle historical pricing in the sidebar to value each session at the rates in effect on its date."}
        </p>
        {query.isError ? (
          <div className="empty-state panel-error">
            <strong>Cost analytics failed.</strong>
            <span>{errorMessage}</span>
          </div>
        ) : query.isLoading || !payload ? (
          <div className="empty-state"><LoadingBar caption="Loading cost analytics…" /></div>
        ) : (
          <>
            <InsightStrip
              payload={payload}
              selectedSpikeBucket={selectedSpikeBucket}
              onSelectSpike={(bucket) => setSelectedSpikeBucket((current) => (
                current === bucket ? null : bucket
              ))}
            />
            <div className="cost-bento">
              {!isTeam && selectedSpike && (
                <SpikeSessionsPanel spike={selectedSpike} onOpenSession={onOpenSession} />
              )}
              <section className="tile">
                <h2>Cost by project</h2>
                <CostByProject payload={payload} colors={colors} available={payload.meta.available} />
              </section>
              <section className="tile">
                <h2>Input/cache economics</h2>
                <TokenCategories payload={payload} />
              </section>
              <section className="tile">
                <h2>Spend over time</h2>
                <SpendOverTime payload={payload} colors={colors} />
              </section>
              <section className="tile">
                <h2>Cost by model</h2>
                <CostByModel payload={payload} colors={colors} available={payload.meta.available} />
              </section>
              {!isTeam && (
                <>
                  <section className="tile tile-full">
                    <h2>Turn distribution</h2>
                    <TurnDistributionSection
                      sessions={payload.sessions}
                      onOpenSession={onOpenSession}
                      available={payload.meta.available}
                    />
                  </section>
                  <section className="tile tile-full">
                    <h2>Session insights</h2>
                    <SessionInsights payload={payload} onOpenSession={onOpenSession} available={payload.meta.available} />
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
