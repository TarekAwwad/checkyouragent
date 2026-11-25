export interface SpendViewState {
  mode: "total" | "model";
  isolatedModel: string | null;
}

export interface CostViewState {
  /** Model filter; date range and project are shared (analysisScope). */
  model: string | null;
  selectedBucket: string | null;
  spend: SpendViewState;
  scrollTop: number;
}

export function initialCostViewState(): CostViewState {
  return {
    model: null,
    selectedBucket: null,
    spend: { mode: "total", isolatedModel: null },
    scrollTop: 0,
  };
}

export type SessionSortKey = "first_ts" | "last_ts" | "cost_usd" | "error_count" | "finding_count" | "event_count" | "subagent_count";

export interface SessionsViewState {
  query: string;
  onlyErrors: boolean;
  sortKey: SessionSortKey;
  scrollTop: number;
}

export function initialSessionsViewState(): SessionsViewState {
  return { query: "", onlyErrors: false, sortKey: "first_ts", scrollTop: 0 };
}
