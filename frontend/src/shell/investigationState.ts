import type { CostAnalyticsFilters } from "../api/types";

export interface SpendViewState {
  mode: "total" | "model";
  isolatedModel: string | null;
}

export interface CostViewState {
  filters: CostAnalyticsFilters;
  rangeKey: string;
  selectedBucket: string | null;
  spend: SpendViewState;
  scrollTop: number;
}

export function initialCostViewState(): CostViewState {
  return {
    filters: { dateFrom: null, dateTo: null },
    rangeKey: "all",
    selectedBucket: null,
    spend: { mode: "total", isolatedModel: null },
    scrollTop: 0,
  };
}

export type SessionSortKey = "first_ts" | "last_ts" | "cost_usd" | "error_count" | "finding_count" | "event_count" | "subagent_count";

export interface SessionsViewState {
  query: string;
  projectId: number | "all";
  onlyErrors: boolean;
  sortKey: SessionSortKey;
  scrollTop: number;
}

export function initialSessionsViewState(): SessionsViewState {
  return { query: "", projectId: "all", onlyErrors: false, sortKey: "first_ts", scrollTop: 0 };
}
