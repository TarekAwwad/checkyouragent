// frontend/src/analytics/CostAnalyticsPage.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostAnalyticsResponse, TurnCostBreakdown } from "../api/types";

// vi.hoisted gives a mock handle usable inside the hoisted vi.mock factory.
const { getCostAnalytics, getSessionTurnCosts } = vi.hoisted(() => ({ getCostAnalytics: vi.fn(), getSessionTurnCosts: vi.fn() }));
vi.mock("../api/client", () => ({ getCostAnalytics, getSessionTurnCosts }));

import CostAnalyticsPage from "./CostAnalyticsPage";

const payload: CostAnalyticsResponse = {
  meta: {
    available: true, unpriced_models: [], total_usd: 48, total_tokens: 5_000_000,
    available_projects: [{ id: 1, name: "alpha" }], available_models: ["claude-opus-4-8"], bucket: "day",
  },
  treemap: [{ project_id: 1, project_name: "alpha", usd: 48, children: [{ model: "claude-opus-4-8", usd: 48 }] }],
  over_time: [
    { bucket: "2026-05-01", per_model: { "claude-opus-4-8": 18 } },
    { bucket: "2026-05-02", per_model: { "claude-opus-4-8": 48 } },
  ],
  categories: {
    base_input: { tokens: 2_000_000, usd: 8 }, cache_write_5m: { tokens: 0, usd: 0 },
    cache_write_1h: { tokens: 0, usd: 0 }, cache_read: { tokens: 1_000_000, usd: 0.5 }, output: { tokens: 2_000_000, usd: 40 },
  },
  by_model: [{
    model: "claude-opus-4-8", usd: 48, tokens: 5_000_000, input_tokens: 3_000_000,
    output_tokens: 2_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 0,
    effective_usd_per_million: 9.6,
  }],
  sessions: [{
    id: 7, session_id: "s1", title: "Session One", project_name: "alpha", usd: 48, tokens: 5_000_000,
    turn_count: 12, tool_call_count: 24, subagent_count: 1, error_count: 2,
    loop_count: 3, max_repeat: 4, finding_count: 1, duration_seconds: 3600,
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
    delta_usd: 30,
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
      loop_count: 0,
      max_repeat: 1,
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
      loop_count: 1,
      max_repeat: 3,
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
      loop_count: 0,
      max_repeat: 1,
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
      loop_count: 0,
      max_repeat: 0,
      models: ["claude-opus-4-8"],
      is_outlier: false,
    },
  ],
};

beforeEach(() => {
  getCostAnalytics.mockReset();
  getSessionTurnCosts.mockReset();
  getCostAnalytics.mockResolvedValue(payload);
  getSessionTurnCosts.mockResolvedValue(turnBreakdown);
});

function renderPage(onOpenSession = () => {}, historical?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CostAnalyticsPage onOpenSession={onOpenSession} historical={historical} />
    </QueryClientProvider>,
  );
}

describe("CostAnalyticsPage", () => {
  it("renders the total, a project row, and a clickable session", async () => {
    renderPage();
    expect(await screen.findAllByText(/\$48\.00/)).not.toHaveLength(0);
    expect(await screen.findAllByText("alpha")).not.toHaveLength(0);
    expect(await screen.findAllByText("Session One")).not.toHaveLength(0);
    expect(await screen.findAllByText("Cache saved")).not.toHaveLength(0);
    expect(await screen.findByText("Session insights")).toBeInTheDocument();
    expect(await screen.findAllByText("Turn distribution")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
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

  it("explains where healthy sessions should land in turn distribution mode", async () => {
    const view = renderPage();

    expect(await screen.findAllByText("Outside target")).not.toHaveLength(0);
    expect(screen.getByText("target zone")).toBeInTheDocument();
    expect(view.container.querySelector(".tb-target-zone")).not.toBeNull();
    expect(view.container.querySelector(".tb-outlier-ring")).not.toBeNull();
    expect(screen.getByText("outlier turns")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(screen.getByText("sessions land outside the cheap-and-steady zone")).toBeInTheDocument();
    expect(screen.getByText(/Ring:/)).toBeInTheDocument();
    expect(screen.getByText(/Lower-left:/)).toBeInTheDocument();
  });

  it("opens an outlier investigation card before navigating to the session page", async () => {
    const onOpenSession = vi.fn();
    const view = renderPage(onOpenSession);

    fireEvent.click(await screen.findByRole("button", { name: /Session One: median \$1\.50, p95 \$6\.40/ }));

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Turn outlier investigation")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Turn cost drilldown" })).toBeInTheDocument();
    expect(await screen.findByText(/Repeated tool activity appears in this turn/)).toBeInTheDocument();
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

  it("shows an error instead of loading forever when analytics fails", async () => {
    getCostAnalytics.mockRejectedValueOnce(new Error("no such column: m.base_input_tokens"));
    renderPage();
    expect(await screen.findByText("Cost analytics failed.")).toBeInTheDocument();
    expect(await screen.findByText(/base_input_tokens/)).toBeInTheDocument();
  });
});
