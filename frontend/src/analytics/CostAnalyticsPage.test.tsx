// frontend/src/analytics/CostAnalyticsPage.test.tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostAnalyticsResponse, TurnCostBreakdown } from "../api/types";

// vi.hoisted gives a mock handle usable inside the hoisted vi.mock factory.
const { getCostAnalytics, getTeamCostAnalytics, getSessionTurnCosts } = vi.hoisted(() => ({
  getCostAnalytics: vi.fn(),
  getTeamCostAnalytics: vi.fn(),
  getSessionTurnCosts: vi.fn(),
}));
vi.mock("../api/client", () => ({ getCostAnalytics, getTeamCostAnalytics, getSessionTurnCosts }));

import CostAnalyticsPage from "./CostAnalyticsPage";

const payload: CostAnalyticsResponse = {
  meta: {
    available: true, unpriced_models: [], costs_partial: false, costs_are_lower_bound: false,
    total_usd: 48, total_tokens: 5_000_000,
    available_projects: [{ id: 1, name: "alpha" }],
    available_models: ["claude-opus-4-8", "claude-sonnet-4-5-20250929"], bucket: "day",
  },
  treemap: [{ project_id: 1, project_name: "alpha", usd: 48, children: [{ model: "claude-opus-4-8", usd: 48 }] }],
  over_time: [
    {
      bucket: "2026-05-01", per_model: { "claude-opus-4-8": 18 }, total_usd: 18,
      session_count: 1, priced_session_count: 1, unpriced_models: [], costs_are_lower_bound: false,
      baseline_usd: null, delta_usd: null, delta_pct: null, is_spike: false, sessions: [],
    },
    {
      bucket: "2026-05-02", per_model: { "claude-opus-4-8": 48 }, total_usd: 48,
      session_count: 1, priced_session_count: 1, unpriced_models: [], costs_are_lower_bound: false,
      baseline_usd: 18, delta_usd: 30, delta_pct: 166.67, is_spike: true,
      sessions: [{ id: 7, session_id: "s1", title: "Session One", project_name: "alpha", usd: 48, tokens: 5_000_000 }],
    },
  ],
  categories: {
    base_input: { tokens: 2_000_000, usd: 8 }, cache_write_5m: { tokens: 0, usd: 0 },
    cache_write_1h: { tokens: 0, usd: 0 }, cache_read: { tokens: 1_000_000, usd: 0.5 }, output: { tokens: 2_000_000, usd: 40 },
  },
  by_model: [{
    model: "claude-opus-4-8", usd: 48, tokens: 5_000_000, input_tokens: 3_000_000,
    output_tokens: 2_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 0,
    effective_usd_per_million: 9.6,
  }, {
    model: "claude-sonnet-4-5-20250929", usd: 1, tokens: 100_000, input_tokens: 80_000,
    output_tokens: 20_000, cache_read_tokens: 0, cache_write_tokens: 0,
    effective_usd_per_million: 10,
  }],
  sessions: [{
    id: 7, session_id: "s1", title: "Session One", project_name: "alpha", usd: 48, tokens: 5_000_000,
    turn_count: 12, tool_call_count: 24, subagent_count: 1, error_count: 2,
    finding_count: 1, duration_seconds: 3600,
    turn_cost_stats: { turn_count: 12, median_usd: 1.5, p95_usd: 6.4, max_usd: 8.2, outlier_count: 2 },
  }],
  cache_economics: {
    observed_input_usd: 8.5,
    no_cache_input_usd: 15,
    net_savings_usd: 6.5,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 0,
    by_model: [{
      model: "claude-opus-4-8", observed_input_usd: 8.5, no_cache_input_usd: 15,
      net_savings_usd: 6.5, input_tokens: 3_000_000, cache_read_tokens: 1_000_000,
      cache_write_tokens: 0,
    }],
  },
  spikes: [{
    bucket: "2026-05-02",
    total_usd: 48,
    baseline_usd: 18,
    delta_usd: 30,
    delta_pct: 166.67,
    sessions: [{ id: 7, session_id: "s1", title: "Session One", project_name: "alpha", usd: 48, tokens: 5_000_000 }],
  }],
};

const turnBreakdown: TurnCostBreakdown = {
  session_id: 7,
  turn_count: 4,
  median_usd: 1.5,
  p95_usd: 6.4,
  max_usd: 8.2,
  outlier_threshold_usd: 3.2,
  outlier_count: 1,
  turns: [
    {
      index: 1,
      start_event_id: 101,
      title: "Turn 1",
      preview: "Summarize the import log",
      start_timestamp: "2026-05-02T00:00:00Z",
      usd: 1.1,
      input_tokens: 80_000,
      output_tokens: 20_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      event_count: 3,
      assistant_message_count: 1,
      tool_call_count: 1,
      error_count: 0,
      subagent_count: 0,
      models: ["claude-opus-4-8"],
      is_outlier: false,
    },
    {
      index: 2,
      start_event_id: 102,
      title: "Turn 2",
      preview: "Investigate a retry storm around the importer",
      start_timestamp: "2026-05-02T00:05:00Z",
      usd: 8.2,
      input_tokens: 520_000,
      output_tokens: 180_000,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      event_count: 11,
      assistant_message_count: 3,
      tool_call_count: 6,
      error_count: 1,
      subagent_count: 2,
      models: ["claude-opus-4-8", "claude-sonnet-4-6"],
      is_outlier: true,
    },
    {
      index: 3,
      start_event_id: 103,
      title: "Turn 3",
      preview: "Check the pricing table",
      start_timestamp: "2026-05-02T00:10:00Z",
      usd: 1.5,
      input_tokens: 90_000,
      output_tokens: 30_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      event_count: 4,
      assistant_message_count: 1,
      tool_call_count: 1,
      error_count: 0,
      subagent_count: 0,
      models: ["claude-opus-4-8"],
      is_outlier: false,
    },
    {
      index: 4,
      start_event_id: 104,
      title: "Turn 4",
      preview: "Wrap up findings",
      start_timestamp: "2026-05-02T00:15:00Z",
      usd: 1.4,
      input_tokens: 70_000,
      output_tokens: 30_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      event_count: 3,
      assistant_message_count: 1,
      tool_call_count: 0,
      error_count: 0,
      subagent_count: 0,
      models: ["claude-opus-4-8"],
      is_outlier: false,
    },
  ],
};

beforeEach(() => {
  getCostAnalytics.mockReset();
  getTeamCostAnalytics.mockReset();
  getSessionTurnCosts.mockReset();
  getCostAnalytics.mockResolvedValue(payload);
  getTeamCostAnalytics.mockResolvedValue(payload);
  getSessionTurnCosts.mockResolvedValue(turnBreakdown);
});

function renderPage(
  onOpenSession = () => {},
  historical?: boolean,
  scope: "local" | "team" = "local",
  onHistoricalChange = (_value: boolean) => {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CostAnalyticsPage
        onOpenSession={onOpenSession}
        historical={historical}
        onHistoricalChange={onHistoricalChange}
        scope={scope}
      />
    </QueryClientProvider>,
  );
}

describe("CostAnalyticsPage", () => {
  it("opens with all imported history so the initial landing is not limited to recent activity", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Cost by model" });
    expect(screen.getByLabelText("Date range")).toHaveValue("all");
    expect(screen.getByLabelText("Start date")).toHaveValue("");
    expect(screen.getByLabelText("End date")).toHaveValue("");
    expect(getCostAnalytics.mock.calls[0][0]).toMatchObject({ dateFrom: null, dateTo: null });
  });

  it("keeps the chart panels mounted while a different date range loads", async () => {
    let finishRequest!: (value: CostAnalyticsResponse) => void;
    getCostAnalytics.mockResolvedValueOnce(payload).mockImplementationOnce(() => (
      new Promise<CostAnalyticsResponse>((resolve) => { finishRequest = resolve; })
    ));
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Spend over time" });
    const modelCosts = screen.getByRole("region", { name: "Model costs" });

    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7" } });

    expect(await screen.findByText("Updating…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Spend over time" })).toBe(heading);
    expect(screen.getByRole("region", { name: "Model costs" })).toBe(modelCosts);
    expect(screen.queryByText("Loading cost analytics…")).not.toBeInTheDocument();

    finishRequest({ ...payload, meta: { ...payload.meta, total_usd: 99 } });
    expect(await screen.findByText("$99.00")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByText("Updating…")).not.toBeInTheDocument());
  });

  it.each(["scope", "pricing"] as const)("does not retain results across a %s change", async (change) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} scope="local" historical />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Cost by model" });
    if (change === "scope") getTeamCostAnalytics.mockImplementation(() => new Promise(() => {}));
    else getCostAnalytics.mockImplementation(() => new Promise(() => {}));

    view.rerender(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} scope={change === "scope" ? "team" : "local"} historical={change === "scope"} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Loading cost analytics…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cost by model" })).not.toBeInTheDocument();
  });

  it("renders the total, a project row, and a clickable session", async () => {
    renderPage();
    expect(await screen.findAllByText(/\$48\.00/)).not.toHaveLength(0);
    expect(await screen.findAllByText("alpha")).not.toHaveLength(0);
    expect(await screen.findAllByText("Session One")).not.toHaveLength(0);
    expect(await screen.findAllByText("Estimated API-equivalent cache savings")).not.toHaveLength(0);
    expect(await screen.findByText(/1M read tokens reused/)).toBeInTheDocument();
    expect(await screen.findByText("Session insights")).toBeInTheDocument();
    expect(await screen.findAllByText("Turn distribution")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.getByText("Estimated API-equivalent cost")).toBeInTheDocument();
    expect(screen.getAllByText("Estimated API-equivalent cache savings")).toHaveLength(1);
    expect(screen.queryByLabelText("Cost insights")).not.toBeInTheDocument();
    expect(screen.getByText("100% of spend")).toBeInTheDocument();
    const trendTile = screen.getByRole("heading", { name: "Spend over time" }).closest("section")!;
    expect(within(trendTile).getByText("Largest daily increase")).toBeInTheDocument();
    expect(screen.getAllByText("sonnet-4-5-20250929")).not.toHaveLength(0);
  });

  it("in team scope uses the team cost endpoint and hides the session-level panels", async () => {
    renderPage(() => {}, undefined, "team");

    // Aggregate panels still render...
    expect(await screen.findByText("Cost by model")).toBeInTheDocument();
    expect(getTeamCostAnalytics).toHaveBeenCalled();
    expect(getCostAnalytics).not.toHaveBeenCalled();
    // ...but the session-level panels (no team equivalent) are gone.
    expect(screen.queryByText("Session insights")).not.toBeInTheDocument();
    expect(screen.queryByText("Turn distribution")).not.toBeInTheDocument();
  });

  it("clears the project/model filters but preserves dates when scope changes", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} scope="local" />
      </QueryClientProvider>,
    );
    await screen.findAllByText("alpha");

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    await vi.waitFor(() =>
      expect(getCostAnalytics.mock.calls.some(([f]) => f.projectId === 1)).toBe(true),
    );
    // Let the refetch resolve (repopulating meta.available_models) before the
    // Model select's options exist to pick from.
    await screen.findAllByText("alpha");

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-opus-4-8" } });
    await vi.waitFor(() =>
      expect(getCostAnalytics.mock.calls.some(([f]) => f.projectId === 1 && f.model === "claude-opus-4-8")).toBe(true),
    );
    const localDateFrom = getCostAnalytics.mock.calls[getCostAnalytics.mock.calls.length - 1][0].dateFrom;

    view.rerender(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} scope="team" />
      </QueryClientProvider>,
    );

    // The team endpoint must never see the local scope's projectId/model (different
    // namespaces), but the scope-agnostic date filters must survive the switch.
    await vi.waitFor(() =>
      expect(getTeamCostAnalytics.mock.calls.some(([f]) => f.projectId == null && f.model == null)).toBe(true),
    );
    const teamCall = getTeamCostAnalytics.mock.calls[getTeamCostAnalytics.mock.calls.length - 1][0];
    expect(teamCall.projectId).toBeFalsy();
    expect(teamCall.model).toBeFalsy();
    expect(teamCall.dateFrom).toBe(localDateFrom);
  });

  it("applies custom start and end date filters", async () => {
    renderPage();
    await screen.findAllByText("alpha");

    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-01" } });

    expect((screen.getByLabelText("Date range") as HTMLSelectElement).value).toBe("custom");
    await vi.waitFor(() =>
      expect(getCostAnalytics.mock.calls.some(([nextFilters]) => (
        nextFilters.dateFrom === "2026-05-01T00:00:00.000Z"
      ))).toBe(true),
    );

    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-05-02" } });

    await vi.waitFor(() =>
      expect(getCostAnalytics.mock.calls.some(([nextFilters]) => (
        nextFilters.dateFrom === "2026-05-01T00:00:00.000Z"
        && nextFilters.dateTo === "2026-05-02T23:59:59.999Z"
      ))).toBe(true),
    );
  });

  it("surfaces largest spike sessions with an open session action", async () => {
    const onOpenSession = vi.fn();
    renderPage(onOpenSession);

    fireEvent.click(await screen.findByRole("button", { name: "Show largest daily increase sessions for May 2, 2026" }));

    const spikePanel = await screen.findByLabelText("Sessions for May 2, 2026");
    expect(within(spikePanel).getByRole("heading", { name: "Sessions on May 2, 2026" })).toBeInTheDocument();
    expect(within(spikePanel).getByText(/\$48\.00 total.*\+\$30\.00 above baseline/)).toBeInTheDocument();
    expect(within(spikePanel).getByText("Session One")).toBeInTheDocument();

    fireEvent.click(within(spikePanel).getByRole("button", { name: "Open session" }));

    expect(onOpenSession).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByRole("button", { name: "Hide largest daily increase sessions for May 2, 2026" }));

    expect(screen.queryByLabelText("Sessions for May 2, 2026")).not.toBeInTheDocument();
  });

  it("opens a bucket's contributor sessions directly from Spend over time", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /May 2, 2026.*1 session priced/i }));

    const panel = await screen.findByLabelText("Sessions for May 2, 2026");
    expect(within(panel).getByText("Session One")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Close sessions for May 2, 2026" }));

    expect(screen.queryByLabelText("Sessions for May 2, 2026")).not.toBeInTheDocument();
  });

  it("labels partial prices as lower bounds and suppresses unsupported comparisons", async () => {
    getCostAnalytics.mockResolvedValueOnce({
      ...payload,
      meta: {
        ...payload.meta,
        unpriced_models: ["claude-unknown-9"],
        costs_partial: true,
        costs_are_lower_bound: true,
      },
      spikes: [],
    });
    renderPage();

    expect(await screen.findByText("≥$48.00")).toBeInTheDocument();
    expect(screen.getByText(/lower bound.*excludes 1 unpriced model/i)).toBeInTheDocument();
    expect(screen.getByText("Spike comparison unavailable")).toBeInTheDocument();
    expect(screen.getByText("Spend shares are hidden because some model usage is unpriced.")).toBeInTheDocument();
    expect(screen.queryByText(/% of spend/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Cache comparison unavailable")).toHaveLength(1);
    expect(screen.getByText("Priced usage only; unpriced models are excluded.")).toBeInTheDocument();
    expect(screen.queryByText("Estimated API-equivalent cache savings")).not.toBeInTheDocument();
  });

  it("passes the pricing mode to the request and refetches when it flips", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} historical={true} />
      </QueryClientProvider>,
    );
    await screen.findAllByText("alpha");
    expect(getCostAnalytics.mock.calls[0][1]).toBe(true);

    view.rerender(
      <QueryClientProvider client={qc}>
        <CostAnalyticsPage onOpenSession={() => {}} historical={false} />
      </QueryClientProvider>,
    );
    // Flipping the mode must drive a fresh request carrying the new mode.
    await vi.waitFor(() =>
      expect(getCostAnalytics.mock.calls.some((c) => c[1] === false)).toBe(true),
    );
  });

  it("shows the unavailable message on $-tiles when pricing is missing", async () => {
    getCostAnalytics.mockResolvedValueOnce({ ...payload, meta: { ...payload.meta, available: false } });
    renderPage();
    expect(await screen.findAllByText(/Cost estimate unavailable/)).not.toHaveLength(0);
  });

  it("describes the observed turn distribution without an arbitrary target", async () => {
    const view = renderPage();

    expect(await screen.findByText("Observed sample")).toBeInTheDocument();
    expect(screen.getByText("1 session")).toBeInTheDocument();
    expect(screen.queryByText(/Outside target/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/target zone/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cheap and steady/i)).not.toBeInTheDocument();
    expect(view.container.querySelector(".tb-target-zone")).toBeNull();
    expect(view.container.querySelector(".tb-reference-x")).not.toBeNull();
    expect(view.container.querySelector(".tb-reference-y")).not.toBeNull();
    expect(view.container.querySelector(".tb-outlier-ring")).not.toBeNull();
    expect(screen.getByText("outlier turns")).toBeInTheDocument();
    expect(screen.getByText("observed medians")).toBeInTheDocument();
    expect(screen.getByText("median $/turn")).toBeInTheDocument();
    expect(screen.getByText("p95 $/turn")).toBeInTheDocument();
    expect(screen.getByText(/Ring:/)).toBeInTheDocument();
    expect(screen.getByText(/Right:/)).toBeInTheDocument();
  });

  it("opens an outlier investigation card before navigating to the session page", async () => {
    const onOpenSession = vi.fn();
    const view = renderPage(onOpenSession);

    fireEvent.click(await screen.findByRole("button", { name: /Session One: median \$1\.50, p95 \$6\.40/ }));

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Turn outlier investigation")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Turn cost drilldown" })).toBeInTheDocument();
    expect(await screen.findByText(/It includes 6 tool calls/)).toBeInTheDocument();
    expect(screen.getByText(/It records 2 subagent events/)).toBeInTheDocument();
    expect(screen.getByText(/It records 1 tool error/)).toBeInTheDocument();
    expect(screen.getByText("Observed context")).toBeInTheDocument();
    expect(screen.queryByText(/orchestration overhead|extra model calls|retries or fallback work pushed spend/i)).not.toBeInTheDocument();
    expect(view.container.querySelector(".turn-insight-layout > .turn-detail-card")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open session page" }));

    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it("describes historical pricing mode in the cost note", async () => {
    renderPage();
    expect(
      await screen.findByText(/priced at the rates in effect on each session/i),
    ).toBeInTheDocument();
  });

  it("switches the cost note to current-rate wording when historical pricing is off", async () => {
    renderPage(() => {}, false);
    expect(
      await screen.findByText(/priced at current rates for every session/i),
    ).toBeInTheDocument();
  });

  it("offers the persisted historical-pricing mode as a labeled Cost control", async () => {
    const onHistoricalChange = vi.fn();
    renderPage(() => {}, true, "local", onHistoricalChange);

    const control = await screen.findByRole("checkbox", { name: "Historical pricing" });
    expect(control).toBeChecked();
    fireEvent.click(control);
    expect(onHistoricalChange).toHaveBeenCalledWith(false);
  });

  it("shows an error instead of loading forever when analytics fails", async () => {
    getCostAnalytics.mockRejectedValueOnce(new Error("no such column: m.base_input_tokens"));
    renderPage();
    expect(await screen.findByText("Cost analytics failed.")).toBeInTheDocument();
    expect(await screen.findByText(/base_input_tokens/)).toBeInTheDocument();
  });
});
