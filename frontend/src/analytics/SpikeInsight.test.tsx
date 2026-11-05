import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CostAnalyticsResponse, SpendSpike } from "../api/types";
import SpikeInsight from "./SpikeInsight";

const spike: SpendSpike = {
  bucket: "2026-05-02", bucket_start: "2026-05-02", bucket_end: "2026-05-02",
  baseline_period_count: 7, is_complete: true,
  total_usd: 48, baseline_usd: 18, delta_usd: 30, delta_pct: 166.67, sessions: [],
};
const payload: CostAnalyticsResponse = {
  meta: {
    available: true, costs_partial: false, costs_are_lower_bound: false, unpriced_models: [],
    total_usd: 48, total_tokens: 100, available_projects: [], available_models: [], bucket: "day",
  },
  treemap: [], over_time: [], by_model: [], sessions: [], spikes: [spike],
  categories: {
    base_input: { tokens: 0, usd: 0 }, cache_write_5m: { tokens: 0, usd: 0 },
    cache_write_1h: { tokens: 0, usd: 0 }, cache_read: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0 },
  },
  cache_economics: { observed_input_usd: 0, no_cache_input_usd: 0, net_savings_usd: 0, cache_read_tokens: 0, cache_write_tokens: 0, by_model: [] },
};

describe("SpikeInsight", () => {
  it("explains the dollar increase and baseline, then opens the contributing period", () => {
    const onSelectBucket = vi.fn();
    const view = render(<SpikeInsight payload={payload} onSelectBucket={onSelectBucket} />);
    const trigger = screen.getByRole("button", { name: "Show largest daily increase sessions for May 2, 2026" });
    expect(trigger).toHaveTextContent("+$30.00 above typical daily spend");
    expect(trigger).toHaveTextContent("May 2, 2026 · $48.00 total · $18.00 baseline");
    expect(trigger).toHaveTextContent("Median of preceding 7 complete days · +167%");
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trigger);
    expect(onSelectBucket).toHaveBeenCalledWith("2026-05-02");

    view.rerender(<SpikeInsight payload={payload} selectedBucket={spike.bucket} onSelectBucket={onSelectBucket} />);
    expect(screen.getByRole("button", { name: "Hide largest daily increase sessions for May 2, 2026" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("labels a weekly increase with a calendar date and weekly comparator", () => {
    render(<SpikeInsight payload={{ ...payload, meta: { ...payload.meta, bucket: "week" }, spikes: [{ ...spike, bucket: "2026-43", bucket_start: "2026-10-26", bucket_end: "2026-11-01", baseline_period_count: 4 }] }} />);
    expect(screen.getByText("Largest weekly increase")).toBeInTheDocument();
    expect(screen.getByText(/Week of Oct 26, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Median of preceding 4 complete weeks/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-43/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("avoids percentages against zero or negligible baselines", () => {
    const view = render(<SpikeInsight payload={{ ...payload, spikes: [{ ...spike, total_usd: 30, baseline_usd: 0, delta_pct: null }] }} />);
    expect(screen.getByText(/Increased from \$0/)).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("%");
    expect(view.container.textContent).not.toContain("Infinity");

    view.rerender(<SpikeInsight payload={{ ...payload, spikes: [{ ...spike, baseline_usd: 0.01, delta_pct: 300_000 }] }} />);
    expect(screen.getByText(/\$0\.01 baseline/)).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("%");
  });

  it("suppresses unsupported spike comparisons when prices are partial", () => {
    render(<SpikeInsight payload={{ ...payload, meta: { ...payload.meta, costs_partial: true } }} onSelectBucket={vi.fn()} />);
    expect(screen.getByText("Spike comparison unavailable")).toBeInTheDocument();
    expect(screen.getByText("Requires complete model pricing")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/\+167%/)).not.toBeInTheDocument();
  });
});
