import type { LimitEraEntry, LimitHitEntry, LimitWindowEntry } from "../../api/types";

export function formatBlocked(minutes: number): string {
  if (!minutes) return "0h";
  const hours = minutes / 60;
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "n/a";
  return `$${value >= 100 ? value.toFixed(0) : value.toFixed(1)}`;
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

export function meanUsageAtHit(era: LimitEraEntry): number | null {
  if (era.usage_at_hit_usd.length === 0) return null;
  const sum = era.usage_at_hit_usd.reduce((s, v) => s + v, 0);
  return sum / era.usage_at_hit_usd.length;
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
  if (era.cap_percentile != null && era.cap_percentile >= COMFORTABLE_CAP_PERCENTILE) {
    const topPct = Math.max(1, Math.round((1 - era.cap_percentile) * 100));
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
