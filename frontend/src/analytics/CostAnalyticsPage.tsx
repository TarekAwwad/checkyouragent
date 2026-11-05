import React from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { getCostAnalytics, getTeamCostAnalytics } from "../api/client";
import type { CostAnalyticsFilters, CostAnalyticsMeta, OverTimeBucket } from "../api/types";
import type { DataScope } from "../shell/useDataScope";
import type { CostViewState } from "../shell/investigationState";
import { initialCostViewState } from "../shell/investigationState";
import { buildModelColorMap, formatSignedUsd, formatTokens, formatUsd } from "./chartGeometry";
import FilterBar from "./FilterBar";
import CostByProject from "./CostByProject";
import SpendOverTime from "./SpendOverTime";
import TokenCategories from "./TokenCategories";
import CostByModel from "./CostByModel";
import LoadingBar from "../components/LoadingBar";
import SessionInsights, { TurnDistributionSection } from "./SessionInsights";
import { Blurred } from "../shell/Blurred";
import { formatCostPeriod, spikeBaselineDescription } from "./costPeriods";

interface Props {
  onOpenSession: (sessionId: number) => void;
  /** Whether historical (date-effective) pricing is active; drives the pricing-mode note. */
  historical?: boolean;
  /** Persists the pricing mode through the app's existing settings state. */
  onHistoricalChange?: (value: boolean) => void;
  /** In team scope, Cost is computed from imported bundles and the session-level
   * panels (which have no team equivalent) are hidden. Defaults to local. */
  scope?: DataScope;
  /** Scoped, in-memory context supplied by the app while this page unmounts. */
  memory?: React.MutableRefObject<CostViewState>;
}

function BucketSessionsPanel({
  bucket,
  bucketSize,
  onOpenSession,
  onClose,
}: {
  bucket: OverTimeBucket;
  bucketSize: CostAnalyticsMeta["bucket"];
  onOpenSession: (sessionId: number) => void;
  onClose: () => void;
}) {
  const rows = React.useMemo(
    () => [...bucket.sessions].sort((a, b) => b.usd - a.usd),
    [bucket.sessions],
  );
  const total = `${bucket.costs_are_lower_bound ? "≥" : ""}${formatUsd(bucket.total_usd)} total`;
  const period = formatCostPeriod(bucket, bucketSize);
  const comparison = bucket.is_spike && bucket.delta_usd !== null
    ? ` - ${formatSignedUsd(bucket.delta_usd)} above baseline`
    : "";

  return (
    <section className="tile tile-full" aria-label={`Sessions for ${period}`}>
      <div className="session-visual-heading bucket-sessions-heading">
        <h2>{bucketSize === "week" ? `Sessions for ${period}` : `Sessions on ${period}`}</h2>
        <button
          type="button"
          className="ghost-action bucket-panel-close"
          onClick={onClose}
          aria-label={`Close sessions for ${period}`}
        >
          <X size={14} aria-hidden={true} />
        </button>
      </div>
      <p className="tile-note">
        {total}{comparison}
      </p>
      {bucket.is_spike && bucket.baseline_usd !== null && bucket.delta_usd !== null && (
        <p className="tile-note">
          {bucket.baseline_usd === 0 ? "Increased from $0" : `${formatUsd(bucket.baseline_usd)} baseline`} · {spikeBaselineDescription({
            ...bucket, baseline_usd: bucket.baseline_usd, delta_usd: bucket.delta_usd,
          }, bucketSize)}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="empty-state">No contributor sessions are available for this bucket.</div>
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

export default function CostAnalyticsPage({
  onOpenSession,
  historical = true,
  onHistoricalChange = () => {},
  scope = "local",
  memory,
}: Props) {
  const isTeam = scope === "team";
  const [filters, setFilters] = React.useState<CostAnalyticsFilters>(() => memory?.current.filters ?? initialCostViewState().filters);
  const [rangeKey, setRangeKey] = React.useState(() => memory?.current.rangeKey ?? "all");
  const [selectedBucket, setSelectedBucket] = React.useState<string | null>(() => memory?.current.selectedBucket ?? null);
  const [spendView, setSpendView] = React.useState(() => memory?.current.spend ?? initialCostViewState().spend);
  const pageRef = React.useRef<HTMLElement>(null);
  const restoredScroll = React.useRef(false);
  const previousScope = React.useRef(scope);

  React.useLayoutEffect(() => {
    if (memory) memory.current = { ...memory.current, filters, rangeKey, selectedBucket, spend: spendView };
  }, [memory, filters, rangeKey, selectedBucket, spendView]);

  // projectId/model are scope-namespaced (local ids vs team synthetic ids /
  // bucketed families); carrying them across a scope switch mis-filters the
  // other scope's data. Dates are scope-agnostic and survive the switch.
  React.useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    setFilters((f) => (f.projectId || f.model ? { ...f, projectId: null, model: null } : f));
  }, [scope]);
  const query = useQuery({
    // `historical` and `scope` are part of the key so flipping the price mode or
    // the data scope is a distinct query (and request URL), not a same-URL
    // refetch that could be served stale from cache.
    queryKey: ["cost-analytics", scope, filters, historical],
    queryFn: () => (isTeam ? getTeamCostAnalytics(filters, historical) : getCostAnalytics(filters, historical)),
    // Keep the chart layout while dates change, without showing local data in
    // team scope or labeling old estimates with a different pricing mode.
    placeholderData: (previousData, previousQuery) => (
      previousQuery?.queryKey[1] === scope && previousQuery?.queryKey[3] === historical
        ? previousData
        : undefined
    ),
  });

  const payload = query.data;
  React.useLayoutEffect(() => {
    if (!restoredScroll.current && payload && pageRef.current) {
      pageRef.current.scrollTop = memory?.current.scrollTop ?? 0;
      restoredScroll.current = true;
    }
  }, [payload, memory]);
  const errorMessage = query.error instanceof Error ? query.error.message : "Unable to load cost analytics.";
  const colors = React.useMemo(
    () => buildModelColorMap(payload?.meta.available_models ?? []),
    [payload?.meta.available_models],
  );
  const selectedTrendBucket = payload?.over_time.find((bucket) => bucket.bucket === selectedBucket) ?? null;

  React.useEffect(() => {
    if (selectedBucket !== null && payload && !payload.over_time.some((bucket) => bucket.bucket === selectedBucket)) {
      setSelectedBucket(null);
    }
  }, [payload, selectedBucket]);

  return (
    <main
      ref={pageRef}
      className="cost-page"
      aria-busy={query.isFetching}
      onScroll={(event) => {
        if (memory && restoredScroll.current) memory.current.scrollTop = event.currentTarget.scrollTop;
      }}
    >
      <div className="cost-page-inner">
        <FilterBar
          filters={filters}
          meta={payload?.meta}
          historical={historical}
          onChange={setFilters}
          onHistoricalChange={onHistoricalChange}
          scope={scope}
          rangeKey={rangeKey}
          onRangeKeyChange={setRangeKey}
        />
        <p className="cost-pricing-note">
          {historical
            ? "Estimated API-equivalent cost is priced at the rates in effect on each session's date."
            : "Estimated API-equivalent cost is priced at current rates for every session."}
          <span className="cost-query-status" role="status">
            {query.isFetching && payload ? "Updating…" : ""}
          </span>
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
            <div className="cost-bento">
              <section className="tile">
                <h2>Cost by project</h2>
                <CostByProject payload={payload} colors={colors} available={payload.meta.available} />
              </section>
              <section className="tile">
                <h2>Input/cache economics</h2>
                <TokenCategories payload={payload} />
              </section>
              <section className="tile cost-trend-tile">
                <SpendOverTime
                  payload={payload}
                  colors={colors}
                  viewState={spendView}
                  onViewStateChange={setSpendView}
                  selectedBucket={isTeam ? undefined : selectedBucket}
                  onSelectBucket={isTeam ? undefined : (bucket) => setSelectedBucket((current) => (
                    current === bucket ? null : bucket
                  ))}
                />
              </section>
              <section className="tile cost-model-tile">
                <h2>Cost by model</h2>
                <CostByModel payload={payload} colors={colors} available={payload.meta.available} />
              </section>
              {!isTeam && selectedTrendBucket && (
                <BucketSessionsPanel
                  bucket={selectedTrendBucket}
                  bucketSize={payload.meta.bucket}
                  onOpenSession={onOpenSession}
                  onClose={() => setSelectedBucket(null)}
                />
              )}
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
