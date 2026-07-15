import type { LimitEraEntry, LimitHitEntry, LimitWindowEntry } from "../../api/types";
import { formatTokens as formatTokenCount, formatUsd } from "../formatting";

export type LimitBasis = "cost" | "tokens";

export function formatBlocked(minutes: number): string {
  if (!minutes) return "0h";
  const hours = minutes / 60;
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

// A measured value the user reads (tooltip, hit detail, era summary): keeps
// cents, because a cheap window is not a free one.
export function formatLimitValue(
  value: number | null | undefined,
  basis: LimitBasis,
): string {
  if (value == null) return "n/a";
  if (value === 0) return basis === "cost" ? "$0" : "0 tok";
  return basis === "cost" ? formatUsd(value) : formatTokenCount(value);
}

// An axis tick: rounded hard, because these sit in a narrow gutter and are
// read against the plot, not quoted.
export function formatLimitTick(value: number, basis: LimitBasis): string {
  if (basis === "tokens") return formatTokenCount(Math.round(value));
  if (value === 0) return "$0";
  return `$${value >= 10 ? Math.round(value) : value.toFixed(1)}`;
}

export interface EraRate {
  hitCount: number;
  weeks: number;
  perWeek: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hits per calendar week of each plan's tenure (the span of its windows in
 * the logs). Tenure is floored at one week so a young corpus reports what
 * actually happened instead of extrapolating a single day into a wild rate.
 */
export function eraRates(
  windows: LimitWindowEntry[],
  hits: LimitHitEntry[],
): Map<string, EraRate> {
  const spans = new Map<string, { from: number; to: number }>();
  windows.forEach((w) => {
    const from = Date.parse(w.start);
    const to = Date.parse(w.end);
    const current = spans.get(w.era);
    if (!current) spans.set(w.era, { from, to });
    else {
      current.from = Math.min(current.from, from);
      current.to = Math.max(current.to, to);
    }
  });
  const counts = new Map<string, number>();
  hits.forEach((h) => {
    if (h.window_index == null) return;
    const window = windows[h.window_index];
    if (!window) return;
    counts.set(window.era, (counts.get(window.era) ?? 0) + 1);
  });
  const rates = new Map<string, EraRate>();
  spans.forEach((span, era) => {
    const weeks = Math.max((span.to - span.from) / WEEK_MS, 1);
    const hitCount = counts.get(era) ?? 0;
    rates.set(era, { hitCount, weeks, perWeek: hitCount / weeks });
  });
  return rates;
}

/** The plan the user is on now: the era of the newest window. */
export function activeEra(windows: LimitWindowEntry[]): string | null {
  return windows.length > 0 ? windows[windows.length - 1].era : null;
}

/** How the selected basis names itself in legends and aria-labels. */
export function basisLabel(basis: LimitBasis): string {
  return basis === "cost" ? "API-equivalent cost" : "token volume";
}

export interface EraCap {
  values: number[];
  median: number | null;
  min: number | null;
  max: number | null;
  nearMissCount: number;
  percentile: number | null;
}

/**
 * The era's cap zone on the selected basis. The backend sends both bases side
 * by side; picking between them belongs here, not in every chart.
 */
export function eraCap(era: LimitEraEntry, basis: LimitBasis): EraCap {
  if (basis === "cost") {
    return {
      values: era.usage_at_hit_usd,
      median: era.cap_median_usd,
      min: era.cap_min_usd,
      max: era.cap_max_usd,
      nearMissCount: era.near_miss_count,
      percentile: era.cap_percentile,
    };
  }
  return {
    values: era.usage_at_hit_tokens,
    median: era.cap_median_tokens,
    min: era.cap_min_tokens,
    max: era.cap_max_tokens,
    nearMissCount: era.near_miss_count_tokens,
    percentile: era.cap_percentile_tokens,
  };
}

/** The window usage a single hit was measured at, on the selected basis. */
export function hitUsage(hit: LimitHitEntry, basis: LimitBasis): number | null {
  return basis === "cost" ? hit.usage_at_hit : hit.usage_at_hit_tokens;
}

export function meanUsageAtHit(
  era: LimitEraEntry,
  basis: LimitBasis = "cost",
): number | null {
  const values = eraCap(era, basis).values;
  if (values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  return sum / values.length;
}

export type VerdictTone = "good" | "watch" | "tight";

export interface Verdict {
  tone: VerdictTone;
  text: string;
}

// Waiting this long per week is treated as the plan being outgrown.
const TIGHT_BLOCKED_MIN_PER_WEEK = 120;
// A cap that only the top decile of windows can reach is a healthy fit.
const COMFORTABLE_CAP_PERCENTILE = 0.9;

/**
 * One-sentence reading of the active plan: is it dimensioned for this usage?
 * Decision markers, in order: no hits at all, heavy weekly waiting, cap only
 * reachable by outlier windows, and the in-between "fits but watch it" case.
 */
export function buildVerdict(
  era: LimitEraEntry | undefined,
  rate: EraRate | undefined,
  basis: LimitBasis = "cost",
): Verdict | null {
  if (!era) return null;
  const plan = era.era || "your plan";
  const weeks = rate?.weeks ?? 1;
  const blockedPerWeek = era.blocked_minutes / weeks;
  if (era.session_hit_count === 0 && era.blocked_minutes === 0) {
    return {
      tone: "good",
      text: `No cap hits recorded on ${plan}. It is comfortably dimensioned for this usage.`,
    };
  }
  if (blockedPerWeek >= TIGHT_BLOCKED_MIN_PER_WEEK) {
    return {
      tone: "tight",
      text: `Caps cost you about ${formatBlocked(blockedPerWeek)} of waiting per week on ${plan}. This usage has outgrown the plan.`,
    };
  }
  const percentile = eraCap(era, basis).percentile;
  if (percentile != null && percentile >= COMFORTABLE_CAP_PERCENTILE) {
    const topPct = Math.max(1, Math.round((1 - percentile) * 100));
    return {
      tone: "good",
      text: `${plan} is well dimensioned: only your top ${topPct}% of windows reach the cap, costing about ${formatBlocked(blockedPerWeek)} of waiting per week.`,
    };
  }
  const perWeek = rate ? rate.perWeek : era.session_hit_count;
  return {
    tone: "watch",
    text: `You hit the ${plan} cap about ${perWeek.toFixed(1)} times a week, costing about ${formatBlocked(blockedPerWeek)} of waiting. The plan fits, but watch the trend.`,
  };
}
