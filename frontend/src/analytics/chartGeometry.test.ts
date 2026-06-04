// frontend/src/analytics/chartGeometry.test.ts
import { describe, expect, it } from "vitest";
import {
  ACCENT_COLOR, formatUsd, formatTokens, buildModelColorMap, orderedModels, displayModelName,
  topProjectsWithRollup, stackedSegments, categoryRows, cacheReadPctOfInput, buildSpendArea,
  largestSpike, topModelSpendSharePct, modelSpendSharePct, modelTokenSharePct,
  effectiveUsdPerMillion, reviewSessions, costPerTurnSessions, costPerTurn, formatSignedUsd,
  chartModels, buildTurnBubblePlot, turnDistributionSessions, turnDistributionSummary,
} from "./chartGeometry";
import type {
  CostAnalyticsResponse, CategoriesBreakdown, ModelCost, OverTimeBucket, SessionCostEntry,
} from "../api/types";

const cats: CategoriesBreakdown = {
  base_input: { tokens: 40, usd: 0 },
  cache_write_5m: { tokens: 0, usd: 0 },
  cache_write_1h: { tokens: 0, usd: 0 },
  cache_read: { tokens: 540, usd: 0 },
  output: { tokens: 20, usd: 0 },
};

const model = (partial: Partial<ModelCost> & { model: string }): ModelCost => ({
  usd: 0,
  tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  effective_usd_per_million: 0,
  ...partial,
});

const session = (partial: Partial<SessionCostEntry> & { id: number }): SessionCostEntry => ({
  session_id: `s-${partial.id}`,
  title: null,
  project_name: "alpha",
  usd: 0,
  tokens: 0,
  turn_count: 0,
  tool_call_count: 0,
  subagent_count: 0,
  error_count: 0,
  loop_count: 0,
  max_repeat: 0,
  finding_count: 0,
  duration_seconds: 0,
  turn_cost_stats: { turn_count: 0, median_usd: 0, p95_usd: 0, max_usd: 0, outlier_count: 0 },
  ...partial,
});

const payload = (partial: Partial<CostAnalyticsResponse>): CostAnalyticsResponse => ({
  meta: {
    available: true,
    unpriced_models: [],
    total_usd: 100,
    total_tokens: 1_000_000,
    available_projects: [],
    available_models: [],
    bucket: "day",
  },
  treemap: [],
  over_time: [],
  categories: cats,
  by_model: [],
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
  ...partial,
});

describe("displayModelName", () => {
  it("drops the claude- prefix when present, leaving the rest intact", () => {
    expect(displayModelName("claude-opus-4-8")).toBe("opus-4-8");
    expect(displayModelName("claude-sonnet-4-5-20250929")).toBe("sonnet-4-5-20250929");
    expect(displayModelName("gpt-4o")).toBe("gpt-4o");
    expect(displayModelName("unknown")).toBe("unknown");
  });
});

describe("formatUsd / formatTokens", () => {
  it("formats dollars and compact tokens", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatSignedUsd(12.5)).toBe("+$12.50");
    expect(formatSignedUsd(-3)).toBe("-$3.00");
    expect(formatTokens(578_000_000)).toBe("578M");
    expect(formatTokens(26_400_000)).toBe("26.4M");
    expect(formatTokens(1240)).toBe("1,240");
    expect(formatTokens(950)).toBe("950");
  });
});

describe("buildModelColorMap", () => {
  it("is stable and distinct regardless of input order", () => {
    const a = buildModelColorMap(["b", "a"]);
    const b = buildModelColorMap(["a", "b"]);
    expect(a.a).toBe(b.a);
    expect(a.a).not.toBe(a.b);
  });

  it("does not assign chart colors to placeholder models", () => {
    const colors = buildModelColorMap(["unknown", "<synthetic>", "claude-opus-4-8"]);
    expect(colors.unknown).toBeUndefined();
    expect(colors["<synthetic>"]).toBeUndefined();
    expect(colors["claude-opus-4-8"]).toBeDefined();
  });

  it("uses the shared accent as the default single-series color", () => {
    expect(buildModelColorMap(["claude-opus-4-8"])["claude-opus-4-8"]).toBe(ACCENT_COLOR);
  });
});

describe("orderedModels", () => {
  it("orders by usd descending", () => {
    expect(orderedModels([
      model({ model: "x", usd: 5 }),
      model({ model: "y", usd: 20 }),
      model({ model: "z", usd: 12 }),
    ])).toEqual(["y", "z", "x"]);
  });

  it("drops zero-cost placeholder rows from chart model order", () => {
    const rows = [
      model({ model: "unknown", usd: 0, tokens: 100 }),
      model({ model: "<synthetic>", usd: 0, tokens: 100 }),
      model({ model: "claude-opus-4-8", usd: 5, tokens: 100 }),
    ];
    expect(chartModels(rows).map((m) => m.model)).toEqual(["claude-opus-4-8"]);
    expect(orderedModels(rows)).toEqual(["claude-opus-4-8"]);
  });
});

describe("topProjectsWithRollup", () => {
  const proj = (id: number, usd: number) => ({ project_id: id, project_name: `p${id}`, usd, children: [] });
  it("returns top N and rolls up the rest", () => {
    const treemap = [proj(1, 100), proj(2, 80), proj(3, 60), proj(4, 40), proj(5, 20), proj(6, 8), proj(7, 2)];
    const { top, rollup } = topProjectsWithRollup(treemap, 5);
    expect(top.map((p) => p.project_id)).toEqual([1, 2, 3, 4, 5]);
    expect(rollup).toEqual({ count: 2, usd: 10 });
  });
  it("has empty rollup when within N", () => {
    expect(topProjectsWithRollup([proj(1, 10), proj(2, 5)], 5).rollup).toEqual({ count: 0, usd: 0 });
  });
});

describe("stackedSegments", () => {
  it("emits non-zero segments in the given model order with percentages", () => {
    const children = [{ model: "y", usd: 30 }, { model: "x", usd: 10 }];
    const segs = stackedSegments(children, ["x", "y", "z"], 40);
    expect(segs.map((s) => s.model)).toEqual(["x", "y"]); // canonical order, z (absent) skipped
    expect(segs[0]).toEqual({ model: "x", usd: 10, pct: 25 });
    expect(segs[1]).toEqual({ model: "y", usd: 30, pct: 75 });
  });
});

describe("categoryRows / cacheReadPctOfInput", () => {
  it("lists non-zero categories in fixed order with % of total tokens", () => {
    const rows = categoryRows(cats);
    expect(rows.map((r) => r.key)).toEqual(["base_input", "cache_read", "output"]);
    expect(rows.find((r) => r.key === "base_input")?.color).toBe(ACCENT_COLOR);
    expect(rows.find((r) => r.key === "cache_read")!.pct).toBe(90); // 540/600
  });
  it("computes cache-read share of input tokens", () => {
    expect(cacheReadPctOfInput(cats)).toBe(93); // 540/(40+0+0+540) = 93.1 -> 93
  });
});

describe("buildSpendArea", () => {
  it("returns one path per present model, 3 y-ticks, and first+last x labels", () => {
    const ot: OverTimeBucket[] = [
      { bucket: "2026-05-01", per_model: { a: 10 } },
      { bucket: "2026-05-02", per_model: { a: 5, b: 15 } },
      { bucket: "2026-05-03", per_model: { b: 20 } },
    ];
    const area = buildSpendArea(ot, ["a", "b"], 600, 150);
    expect(area.paths.map((p) => p.model)).toEqual(["a", "b"]);
    expect(area.paths[0].areaPath.startsWith("M ")).toBe(true);
    expect(area.yTicks).toHaveLength(3);
    expect(area.xLabels[0].label).toBe("2026-05-01");
    expect(area.xLabels[area.xLabels.length - 1].label).toBe("2026-05-03");
  });
  it("handles a single bucket without throwing", () => {
    const area = buildSpendArea([{ bucket: "2026-05-01", per_model: { a: 10 } }], ["a"], 600, 150);
    expect(area.paths).toHaveLength(1);
  });
});

describe("insight helpers", () => {
  it("selects the largest spend spike", () => {
    const p = payload({
      spikes: [
        { bucket: "2026-05-02", total_usd: 30, delta_usd: 5, sessions: [] },
        { bucket: "2026-05-03", total_usd: 80, delta_usd: 50, sessions: [] },
      ],
    });
    expect(largestSpike(p)?.bucket).toBe("2026-05-03");
  });

  it("computes model spend/token shares and effective rate", () => {
    const m = model({ model: "opus", usd: 75, tokens: 250_000, effective_usd_per_million: 300 });
    const p = payload({ by_model: [m, model({ model: "sonnet", usd: 25, tokens: 750_000 })] });
    expect(topModelSpendSharePct(p)).toBe(75);
    expect(modelSpendSharePct(m, p)).toBe(75);
    expect(modelTokenSharePct(m, p)).toBe(25);
    expect(effectiveUsdPerMillion(m)).toBe(300);
  });

  it("ranks review sessions by spend and cost-per-turn sessions by efficiency", () => {
    const rows = [
      session({ id: 1, usd: 10, turn_count: 10, loop_count: 1 }),
      session({ id: 2, usd: 5, turn_count: 1, error_count: 1 }),
      session({ id: 3, usd: 20, turn_count: 20 }),
    ];
    expect(reviewSessions(rows).map((s) => s.id)).toEqual([1, 2]);
    expect(costPerTurn(rows[1])).toBe(5);
    expect(costPerTurnSessions(rows).map((s) => s.id)).toEqual([2, 1, 3]);
  });

  it("ranks turn distribution by p95 and builds bubble plot geometry", () => {
    const rows = [
      session({
        id: 1, usd: 10,
        turn_cost_stats: { turn_count: 6, median_usd: 0.2, p95_usd: 1.2, max_usd: 1.5, outlier_count: 1 },
      }),
      session({
        id: 2, usd: 40,
        turn_cost_stats: { turn_count: 8, median_usd: 0.08, p95_usd: 0.45, max_usd: 1.1, outlier_count: 0 },
      }),
      session({
        id: 3, usd: 5,
        turn_cost_stats: { turn_count: 0, median_usd: 0, p95_usd: 0, max_usd: 0, outlier_count: 0 },
      }),
    ];
    expect(turnDistributionSessions(rows).map((s) => s.id)).toEqual([1, 2]);
    const plot = buildTurnBubblePlot(rows, 640, 240);
    expect(plot.points.map((point) => point.session.id)).toEqual([1, 2]);
    expect(plot.points.find((point) => point.session.id === 1)?.severity).toBe("alert");
    expect(plot.points.find((point) => point.session.id === 2)?.severity).toBe("normal");
    expect(plot.points.find((point) => point.session.id === 1)?.outlierCount).toBe(1);
    expect(plot.points.find((point) => point.session.id === 1)?.outlierRate).toBeCloseTo(1 / 6, 5);
    expect(plot.points.find((point) => point.session.id === 2)!.r).toBeGreaterThan(
      plot.points.find((point) => point.session.id === 1)!.r,
    );
  });

  it("summarizes sessions that need turn attention", () => {
    const rows = [
      session({
        id: 1, usd: 10,
        turn_cost_stats: { turn_count: 6, median_usd: 0.2, p95_usd: 1.2, max_usd: 1.5, outlier_count: 1 },
      }),
      session({
        id: 2, usd: 40,
        turn_cost_stats: { turn_count: 8, median_usd: 0.08, p95_usd: 0.45, max_usd: 1.1, outlier_count: 0 },
      }),
      session({
        id: 3, usd: 12,
        turn_cost_stats: { turn_count: 4, median_usd: 0.55, p95_usd: 0.75, max_usd: 0.8, outlier_count: 0 },
      }),
      session({
        id: 4, usd: 5,
        turn_cost_stats: { turn_count: 0, median_usd: 0, p95_usd: 0, max_usd: 0, outlier_count: 0 },
      }),
    ];

    expect(turnDistributionSummary(rows)).toEqual({ total: 3, attentionCount: 2 });
  });
});
