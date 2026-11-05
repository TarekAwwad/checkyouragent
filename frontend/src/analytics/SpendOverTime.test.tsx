import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CostAnalyticsResponse, OverTimeBucket } from "../api/types";
import SpendOverTime from "./SpendOverTime";

const bucket = (
  day: string,
  perModel: Record<string, number>,
  partial: Partial<OverTimeBucket> = {},
): OverTimeBucket => ({
  bucket: day,
  per_model: perModel,
  total_usd: Object.values(perModel).reduce((sum, value) => sum + value, 0),
  session_count: 2,
  priced_session_count: 2,
  unpriced_models: [],
  costs_are_lower_bound: false,
  baseline_usd: null,
  delta_usd: null,
  delta_pct: null,
  is_spike: false,
  sessions: [],
  ...partial,
});

const payload: CostAnalyticsResponse = {
  meta: {
    available: true,
    unpriced_models: ["claude-unknown-9"],
    costs_partial: true,
    costs_are_lower_bound: true,
    total_usd: 35,
    total_tokens: 1_000,
    available_projects: [],
    available_models: ["claude-opus-4-8", "claude-sonnet-4-6"],
    bucket: "day",
  },
  treemap: [],
  over_time: [
    bucket("2026-05-01", { "claude-opus-4-8": 10, "claude-sonnet-4-6": 5 }),
    bucket(
      "2026-05-02",
      { "claude-opus-4-8": 18, "claude-sonnet-4-6": 2 },
      {
        session_count: 2,
        priced_session_count: 1,
        unpriced_models: ["claude-unknown-9"],
        costs_are_lower_bound: true,
      },
    ),
  ],
  categories: {
    base_input: { tokens: 0, usd: 0 },
    cache_write_5m: { tokens: 0, usd: 0 },
    cache_write_1h: { tokens: 0, usd: 0 },
    cache_read: { tokens: 0, usd: 0 },
    output: { tokens: 0, usd: 0 },
  },
  by_model: [
    {
      model: "claude-opus-4-8", usd: 28, tokens: 700, input_tokens: 500,
      output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0,
      effective_usd_per_million: 40_000,
    },
    {
      model: "claude-sonnet-4-6", usd: 7, tokens: 300, input_tokens: 200,
      output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0,
      effective_usd_per_million: 23_333,
    },
  ],
  sessions: [],
  cache_economics: {
    observed_input_usd: 0,
    no_cache_input_usd: 0,
    net_savings_usd: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    by_model: [],
  },
  spikes: [],
};

const colors = {
  "claude-opus-4-8": "var(--accent)",
  "claude-sonnet-4-6": "var(--warning)",
};

describe("SpendOverTime", () => {
  it("identifies qualified total-spend spikes without marking partial or model-only comparisons", () => {
    const onSelectBucket = vi.fn();
    const complete = {
      ...payload,
      meta: { ...payload.meta, costs_partial: false, costs_are_lower_bound: false, unpriced_models: [] },
      over_time: [bucket("2026-05-01", { "claude-opus-4-8": 30 }, {
        is_spike: true, is_complete: true, baseline_usd: 10, delta_usd: 20, delta_pct: 200,
      })],
    };
    const view = render(<SpendOverTime payload={complete} colors={colors} onSelectBucket={onSelectBucket} />);
    const point = screen.getByRole("button", { name: /May 1, 2026.*unusual increase/i });
    expect(view.container.querySelectorAll(".sot-spike-marker")).toHaveLength(1);
    fireEvent.mouseEnter(point);
    expect(screen.getByRole("status")).toHaveTextContent("Unusual increase · +$20.00 above baseline");
    fireEvent.click(point);
    expect(onSelectBucket).toHaveBeenCalledWith("2026-05-01");

    fireEvent.click(screen.getByRole("radio", { name: "Spend by model" }));
    expect(view.container.querySelector(".sot-spike-marker")).not.toBeInTheDocument();
    expect(screen.queryByText("Unusual increase")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Total spend" }));
    view.rerender(<SpendOverTime payload={{ ...complete, meta: { ...complete.meta, costs_partial: true } }} colors={colors} />);
    expect(view.container.querySelector(".sot-spike-marker")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unusual increase/i })).not.toBeInTheDocument();
  });

  it("clears isolation when a date-range update removes the selected model", () => {
    const view = render(<SpendOverTime payload={payload} colors={colors} />);
    fireEvent.click(screen.getByRole("radio", { name: "Spend by model" }));
    fireEvent.click(screen.getByRole("button", { name: "Show only opus-4-8" }));

    const filtered = {
      ...payload,
      by_model: payload.by_model.filter((model) => model.model === "claude-sonnet-4-6"),
      over_time: payload.over_time.map((period) => ({
        ...period,
        total_usd: period.per_model["claude-sonnet-4-6"],
        per_model: { "claude-sonnet-4-6": period.per_model["claude-sonnet-4-6"] },
      })),
    };
    view.rerender(<SpendOverTime payload={filtered} colors={colors} />);
    expect(view.container.querySelector('[data-series="claude-sonnet-4-6"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show only sonnet-4-6" })).toHaveAttribute("aria-pressed", "false");

    view.rerender(<SpendOverTime payload={payload} colors={colors} />);
    expect(view.container.querySelector('[data-series="claude-opus-4-8"]')).toBeInTheDocument();
    expect(view.container.querySelector('[data-series="claude-sonnet-4-6"]')).toBeInTheDocument();
  });

  it("switches between total and model series and reuses the shared model palette", () => {
    const view = render(<SpendOverTime payload={payload} colors={colors} />);

    expect(screen.getByRole("heading", { name: "Spend over time" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Spend display" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Total spend" })).toHaveAttribute("aria-checked", "true");
    const legendSlot = view.container.querySelector(".sot-legend-slot");
    expect(legendSlot).toBeInTheDocument();
    expect(view.container.querySelector('[data-series="total"]')).toHaveAttribute("stroke", "var(--accent)");

    fireEvent.click(screen.getByRole("radio", { name: "Spend by model" }));

    expect(view.container.querySelector(".sot-legend-slot")).toBe(legendSlot);
    expect(view.container.querySelector('[data-series="claude-opus-4-8"]')).toHaveAttribute("stroke", "var(--accent)");
    expect(view.container.querySelector('[data-series="claude-sonnet-4-6"]')).toHaveAttribute("stroke", "var(--warning)");

    fireEvent.click(screen.getByRole("button", { name: "Show only opus-4-8" }));
    expect(view.container.querySelector('[data-series="claude-opus-4-8"]')).toBeInTheDocument();
    expect(view.container.querySelector('[data-series="claude-sonnet-4-6"]')).not.toBeInTheDocument();
  });

  it("explains exact spend and price coverage for an inspected bucket", () => {
    render(<SpendOverTime payload={payload} colors={colors} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: /May 2, 2026.*1 of 2 sessions priced/i }));

    const tooltip = screen.getByRole("status");
    expect(tooltip).toHaveTextContent("May 2, 2026");
    expect(tooltip).toHaveTextContent("≥$20.00");
    expect(tooltip).toHaveTextContent("1 of 2 sessions priced");
    expect(tooltip).toHaveTextContent("unknown-9 unpriced");
    expect(tooltip).toHaveTextContent("opus-4-8 $18.00");
  });

  it("selects a bucket from the keyboard for contributor drilldown", () => {
    const onSelectBucket = vi.fn();
    render(<SpendOverTime payload={payload} colors={colors} onSelectBucket={onSelectBucket} />);

    fireEvent.keyDown(screen.getByRole("button", { name: /May 1, 2026.*2 sessions priced/i }), { key: "Enter" });

    expect(onSelectBucket).toHaveBeenCalledWith("2026-05-01");
  });

  it("shows calendar dates for weekly keys and identifies incomplete periods", () => {
    const weekly: CostAnalyticsResponse = {
      ...payload,
      meta: { ...payload.meta, bucket: "week" },
      over_time: [bucket("2026-43", { "claude-opus-4-8": 20 }, {
        bucket_start: "2026-10-26", bucket_end: "2026-11-01", is_complete: false,
      })],
    };
    const onSelectBucket = vi.fn();
    const view = render(<SpendOverTime payload={weekly} colors={colors} onSelectBucket={onSelectBucket} />);
    const point = screen.getByRole("button", { name: /Week of Oct 26, 2026.*partial period/i });
    fireEvent.mouseEnter(point);

    expect(screen.getByRole("status")).toHaveTextContent("Week of Oct 26, 2026");
    expect(screen.getByRole("status")).toHaveTextContent("Partial period · excluded from spike comparisons");
    expect(screen.getByText("Oct 26")).toHaveAttribute("title", "Week of Oct 26, 2026");
    expect(screen.getByText("Week starting (UTC)")).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("2026-43");

    fireEvent.click(point);
    expect(onSelectBucket).toHaveBeenCalledWith("2026-43");
  });
});
