import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getCostAnalytics } from "../api/client";
import type { CostAnalyticsFilters } from "../api/types";
import { buildModelColorMap } from "./chartGeometry";
import FilterBar from "./FilterBar";
import CostByProject from "./CostByProject";
import SpendOverTime from "./SpendOverTime";
import TokenCategories from "./TokenCategories";
import CostByModel from "./CostByModel";
import InsightStrip from "./InsightStrip";
import SessionInsights, { TurnDistributionSection } from "./SessionInsights";

interface Props {
  onOpenSession: (sessionId: number) => void;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

export default function CostAnalyticsPage({ onOpenSession }: Props) {
  const [filters, setFilters] = React.useState<CostAnalyticsFilters>({ dateFrom: defaultFrom() });
  const query = useQuery({
    queryKey: ["cost-analytics", filters],
    queryFn: () => getCostAnalytics(filters),
  });

  const payload = query.data;
  const errorMessage = query.error instanceof Error ? query.error.message : "Unable to load cost analytics.";
  const colors = React.useMemo(
    () => buildModelColorMap(payload?.meta.available_models ?? []),
    [payload?.meta.available_models],
  );

  return (
    <main className="cost-page">
      <div className="cost-page-inner">
        <FilterBar filters={filters} meta={payload?.meta} onChange={setFilters} />
        <p className="cost-pricing-note">
          Spend is priced at the rates in effect on each session&apos;s date. Toggle historical pricing in the sidebar to
          value everything at current rates.
        </p>
        {query.isError ? (
          <div className="empty-state panel-error">
            <strong>Cost analytics failed.</strong>
            <span>{errorMessage}</span>
          </div>
        ) : query.isLoading || !payload ? (
          <div className="empty-state">Loading cost analytics...</div>
        ) : (
          <>
            <InsightStrip payload={payload} />
            <div className="cost-bento">
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
            </div>
          </>
        )}
      </div>
    </main>
  );
}
