// frontend/src/analytics/chartGeometry.ts
import type {
  CostAnalyticsResponse, CategoriesBreakdown, ModelCost, SessionCostEntry, SpendSpike,
  TreemapModel, TreemapProject,
} from "../api/types";

export const ACCENT_COLOR = "var(--accent)";
export const SUCCESS_COLOR = "var(--success)";
export const INFO_COLOR = "var(--info)";
export const WARNING_COLOR = "var(--warning)";
export const DANGER_COLOR = "var(--danger)";
export const SUBAGENT_COLOR = "var(--subagent)";
export const NEUTRAL_COLOR = "var(--neutral-visual)";

// Shared chart palette. The first slot is the canonical accent so single-series
// views default to the same brand color used throughout the UI.
export const MODEL_PALETTE = [
  ACCENT_COLOR,
  WARNING_COLOR,
  DANGER_COLOR,
  SUCCESS_COLOR,
  SUBAGENT_COLOR,
  NEUTRAL_COLOR,
  INFO_COLOR,
];
export const FALLBACK_COLOR = ACCENT_COLOR;
const PLACEHOLDER_MODELS = new Set(["unknown", "<synthetic>"]);

const CATEGORY_ORDER = ["base_input", "cache_write_5m", "cache_write_1h", "cache_read", "output"] as const;
type CategoryKey = (typeof CATEGORY_ORDER)[number];
const CATEGORY_LABELS: Record<CategoryKey, string> = {
  base_input: "base input",
  cache_write_5m: "cache write (5m)",
  cache_write_1h: "cache write (1h)",
  cache_read: "cache read",
  output: "output",
};
const CATEGORY_COLORS: Record<CategoryKey, string> = {
  base_input: ACCENT_COLOR,
  cache_write_5m: SUCCESS_COLOR,
  cache_write_1h: INFO_COLOR,
  cache_read: WARNING_COLOR,
  output: DANGER_COLOR,
};

const round = (v: number): number => Math.round(v * 100) / 100;

/** Display label for a model: drop the `claude-` vendor prefix when present. */
export function displayModelName(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSignedUsd(value: number): string {
  if (value === 0) return formatUsd(0);
  return `${value > 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

export function formatUsdPerMillion(value: number): string {
  return `${formatUsd(value)}/M`;
}

export function formatTokens(n: number): string {
  const compact = (v: number, suffix: string) => {
    const s = v.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}${suffix}`;
  };
  if (n >= 1_000_000_000) return compact(n / 1_000_000_000, "B");
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 1_000) return n.toLocaleString("en-US");
  return String(n);
}

/** Stable model -> color, independent of input order. */
export function buildModelColorMap(models: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  [...models].filter((model) => !isPlaceholderModel(model)).sort().forEach((model, i) => {
    map[model] = MODEL_PALETTE[i % MODEL_PALETTE.length];
  });
  return map;
}

export function isPlaceholderModel(model: string): boolean {
  return PLACEHOLDER_MODELS.has(model.trim().toLowerCase());
}

export function chartModels(byModel: ModelCost[]): ModelCost[] {
  return byModel.filter((m) => !isPlaceholderModel(m.model) && m.usd > 0);
}

/** Canonical model order = overall spend descending; drives legend + segment order everywhere. */
export function orderedModels(byModel: ModelCost[]): string[] {
  return chartModels(byModel).sort((a, b) => b.usd - a.usd).map((m) => m.model);
}

export interface ProjectRollup { count: number; usd: number }
export function topProjectsWithRollup(
  treemap: TreemapProject[],
  n = 5,
): { top: TreemapProject[]; rollup: ProjectRollup } {
  const costBearing = treemap.filter((project) => project.usd > 0);
  const top = costBearing.slice(0, n);
  const rest = costBearing.slice(n);
  const rollup = { count: rest.length, usd: round(rest.reduce((s, p) => s + p.usd, 0)) };
  return { top, rollup };
}

export interface Segment { model: string; usd: number; pct: number }
export function stackedSegments(children: TreemapModel[], order: string[], total: number): Segment[] {
  const byModel = new Map(children.map((c) => [c.model, c.usd]));
  const segs: Segment[] = [];
  for (const model of order) {
    const usd = byModel.get(model) ?? 0;
    if (usd <= 0) continue;
    segs.push({ model, usd, pct: total > 0 ? round((usd / total) * 100) : 0 });
  }
  return segs;
}

export interface CategoryRow { key: string; label: string; color: string; tokens: number; pct: number }
export function categoryRows(categories: CategoriesBreakdown): CategoryRow[] {
  const total = CATEGORY_ORDER.reduce((s, k) => s + categories[k].tokens, 0);
  return CATEGORY_ORDER.filter((k) => categories[k].tokens > 0).map((k) => ({
    key: k,
    label: CATEGORY_LABELS[k],
    color: CATEGORY_COLORS[k],
    tokens: categories[k].tokens,
    pct: total > 0 ? Math.round((categories[k].tokens / total) * 100) : 0,
  }));
}

export function cacheReadPctOfInput(categories: CategoriesBreakdown): number {
  const input =
    categories.base_input.tokens + categories.cache_write_5m.tokens +
    categories.cache_write_1h.tokens + categories.cache_read.tokens;
  return input > 0 ? Math.round((categories.cache_read.tokens / input) * 100) : 0;
}

export function largestSpike(payload: CostAnalyticsResponse): SpendSpike | null {
  if (payload.spikes.length === 0) return null;
  return [...payload.spikes].sort((a, b) => b.delta_usd - a.delta_usd)[0];
}

export function topModelSpendSharePct(payload: CostAnalyticsResponse): number {
  const top = [...chartModels(payload.by_model)].sort((a, b) => b.usd - a.usd)[0];
  if (!top || payload.meta.total_usd <= 0) return 0;
  return Math.round((top.usd / payload.meta.total_usd) * 100);
}

export function modelSpendSharePct(model: ModelCost, payload: CostAnalyticsResponse): number {
  return payload.meta.total_usd > 0 ? Math.round((model.usd / payload.meta.total_usd) * 100) : 0;
}

export function modelTokenSharePct(model: ModelCost, payload: CostAnalyticsResponse): number {
  return payload.meta.total_tokens > 0 ? Math.round((model.tokens / payload.meta.total_tokens) * 100) : 0;
}

export function effectiveUsdPerMillion(model: ModelCost): number {
  if (model.effective_usd_per_million > 0) return model.effective_usd_per_million;
  return model.tokens > 0 ? (model.usd / model.tokens) * 1_000_000 : 0;
}

export function costPerTurn(session: SessionCostEntry): number {
  return session.usd / Math.max(session.turn_count, 1);
}

export function reviewSessions(sessions: SessionCostEntry[], limit = 12): SessionCostEntry[] {
  return sessions
    .filter((session) => (
      session.usd > 0
      && (session.loop_count > 0 || session.error_count > 0 || session.finding_count > 0)
    ))
    .sort((a, b) => b.usd - a.usd || b.loop_count - a.loop_count || b.error_count - a.error_count)
    .slice(0, limit);
}

export function costPerTurnSessions(sessions: SessionCostEntry[], limit = 12): SessionCostEntry[] {
  return [...sessions]
    .filter((session) => session.usd > 0)
    .sort((a, b) => costPerTurn(b) - costPerTurn(a))
    .slice(0, limit);
}

export function turnDistributionSessions(sessions: SessionCostEntry[], limit = 12): SessionCostEntry[] {
  return [...sessions]
    .filter((session) => session.usd > 0 && session.turn_cost_stats.turn_count > 0)
    .sort((a, b) => (
      b.turn_cost_stats.p95_usd - a.turn_cost_stats.p95_usd
      || b.turn_cost_stats.max_usd - a.turn_cost_stats.max_usd
      || b.usd - a.usd
    ))
    .slice(0, limit);
}

export interface TurnDistributionSummary {
  total: number;
  attentionCount: number;
}

interface TurnDistributionTarget {
  medianMax: number;
  p95Max: number;
}

function turnDistributionRows(sessions: SessionCostEntry[]): SessionCostEntry[] {
  return sessions.filter((session) => session.usd > 0 && session.turn_cost_stats.turn_count > 0);
}

function turnDistributionTarget(sessions: SessionCostEntry[]): TurnDistributionTarget {
  const rows = turnDistributionRows(sessions);
  const maxMedian = Math.max(...rows.map((session) => session.turn_cost_stats.median_usd), 0);
  const maxP95 = Math.max(...rows.map((session) => session.turn_cost_stats.p95_usd), 0);
  return {
    medianMax: (maxMedian > 0 ? maxMedian : 1) / 2,
    p95Max: (maxP95 > 0 ? maxP95 : 1) / 2,
  };
}

function isOutsideTurnTarget(session: SessionCostEntry, target: TurnDistributionTarget): boolean {
  return (
    session.turn_cost_stats.median_usd > target.medianMax
    || session.turn_cost_stats.p95_usd > target.p95Max
  );
}

export function turnDistributionSummary(sessions: SessionCostEntry[]): TurnDistributionSummary {
  const rows = turnDistributionRows(sessions);
  const target = turnDistributionTarget(sessions);
  const attentionCount = rows.filter((session) => isOutsideTurnTarget(session, target)).length;
  return {
    total: rows.length,
    attentionCount,
  };
}

export interface TurnBubblePoint {
  session: SessionCostEntry;
  x: number;
  y: number;
  r: number;
  severity: "alert" | "normal";
  outlierCount: number;
  outlierRate: number;
}

export interface TurnBubblePlot {
  points: TurnBubblePoint[];
  xTicks: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
}

export function buildTurnBubblePlot(
  sessions: SessionCostEntry[],
  width: number,
  height: number,
): TurnBubblePlot {
  const plotLeft = 52;
  const plotTop = 12;
  const plotWidth = width - plotLeft - 16;
  const plotHeight = height - plotTop - 38;
  const rows = turnDistributionRows(sessions);
  const maxMedian = Math.max(...rows.map((s) => s.turn_cost_stats.median_usd), 0);
  const maxP95 = Math.max(...rows.map((s) => s.turn_cost_stats.p95_usd), 0);
  const maxUsd = Math.max(...rows.map((s) => s.usd), 0);
  const xMax = maxMedian > 0 ? maxMedian : 1;
  const yMax = maxP95 > 0 ? maxP95 : 1;
  const target = turnDistributionTarget(sessions);

  const severityFor = (session: SessionCostEntry): TurnBubblePoint["severity"] => (
    isOutsideTurnTarget(session, target) ? "alert" : "normal"
  );

  const points = rows.map((session) => ({
    outlierCount: session.turn_cost_stats.outlier_count,
    outlierRate: session.turn_cost_stats.outlier_count / Math.max(session.turn_cost_stats.turn_count, 1),
    session,
    x: round(plotLeft + (session.turn_cost_stats.median_usd / xMax) * plotWidth),
    y: round(plotTop + plotHeight - (session.turn_cost_stats.p95_usd / yMax) * plotHeight),
    r: round(5 + (maxUsd > 0 ? Math.sqrt(session.usd / maxUsd) * 13 : 0)),
    severity: severityFor(session),
  }));

  const xTicks = [0, xMax / 2, xMax].map((value) => ({
    x: round(plotLeft + (value / xMax) * plotWidth),
    label: formatUsd(value),
  }));
  const yTicks = [yMax, yMax / 2, 0].map((value) => ({
    y: round(plotTop + plotHeight - (value / yMax) * plotHeight),
    label: formatUsd(value),
  }));

  return { points, xTicks, yTicks, width, height, plotLeft, plotTop, plotWidth, plotHeight };
}

export interface AreaModelPath { model: string; areaPath: string; linePath: string }
export interface SpendArea {
  paths: AreaModelPath[];
  xLabels: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  width: number;
  height: number;
}
export function buildSpendArea(
  overTime: CostAnalyticsResponse["over_time"],
  order: string[],
  width: number,
  height: number,
): SpendArea {
  const n = overTime.length;
  const models = order.filter((m) => overTime.some((b) => (b.per_model[m] ?? 0) > 0));
  const totals = overTime.map((b) => models.reduce((s, m) => s + (b.per_model[m] ?? 0), 0));
  const maxTotal = totals.length ? Math.max(...totals) : 0;
  const xAt = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const yAt = (v: number) => (maxTotal > 0 ? height - (v / maxTotal) * height : height);

  const paths: AreaModelPath[] = [];
  const lower = new Array(n).fill(0);
  for (const model of models) {
    const upper = overTime.map((b, i) => lower[i] + (b.per_model[model] ?? 0));
    const topPts = upper.map((v, i) => `${round(xAt(i))},${round(yAt(v))}`);
    const botPts = lower.map((v, i) => `${round(xAt(i))},${round(yAt(v))}`).reverse();
    paths.push({
      model,
      areaPath: `M ${topPts.join(" L ")} L ${botPts.join(" L ")} Z`,
      linePath: `M ${topPts.join(" L ")}`,
    });
    for (let i = 0; i < n; i += 1) lower[i] = upper[i];
  }

  const step = Math.max(1, Math.ceil(n / 6));
  const idxs = new Set<number>();
  for (let i = 0; i < n; i += step) idxs.add(i);
  if (n > 0) idxs.add(n - 1);
  const xLabels = [...idxs].sort((a, b) => a - b).map((i) => ({ x: round(xAt(i)), label: overTime[i].bucket }));

  const yTicks = maxTotal > 0
    ? [maxTotal, maxTotal / 2, 0].map((v) => ({ y: round(yAt(v)), label: `$${Math.round(v)}` }))
    : [{ y: height, label: "$0" }];

  return { paths, xLabels, yTicks, width, height };
}
