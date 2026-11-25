import type { LimitEraEntry, LimitHitEntry } from "../../api/types";
import { formatTokens as formatTokenCount, formatUsd } from "../formatting";

export type LimitBasis = "cost" | "tokens";

export function formatResetInterval(minutes: number): string {
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

/**
 * How a plan period names itself. An era is one plan period, not one plan: a
 * plan held twice is two eras, told apart by eraDateRange. The unplanned era
 * is everything when there is no history, else what predates the first entry.
 */
export function eraName(era: LimitEraEntry, eraCount: number): string {
  if (era.era) return era.era;
  return eraCount > 1 ? "Before plan history" : "All usage";
}

// Plan dates are calendar days ("2026-05-01"), so they format in UTC: read as
// local midnight they would print the day before anywhere west of Greenwich.
function planDay(day: string, now: Date, locale: string | undefined): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(date.getUTCFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/**
 * The period's plan dates, end exclusive (the day the next plan began).
 * `locale` defaults to the viewer's; tests pin it.
 */
export function eraDateRange(
  era: LimitEraEntry,
  now: Date = new Date(),
  locale?: string,
): string | null {
  const { start_date: start, end_date: end } = era;
  const day = (value: string) => planDay(value, now, locale);
  if (start && end) return `${day(start)} – ${day(end)}`;
  if (start) return `since ${day(start)}`;
  if (end) return `until ${day(end)}`;
  return null;
}

/**
 * A period's session-hit rate: "2.3 hits/wk", or "2.3/wk" in a hit-level row,
 * where the hit count just before it already names the unit.
 */
export function formatHitRate(era: LimitEraEntry, short = false): string {
  return `${era.hits_per_week.toFixed(1)}${short ? "/wk" : " hits/wk"}`;
}

export interface EraHitLevel {
  values: number[];
  median: number | null;
  min: number | null;
  max: number | null;
  percentile: number | null;
}

/**
 * The era's hit levels on the selected basis. The backend sends both bases side
 * by side; picking between them belongs here, not in every chart.
 */
export function eraHitLevel(era: LimitEraEntry, basis: LimitBasis): EraHitLevel {
  if (basis === "cost") {
    return {
      values: era.usage_at_hit_usd,
      median: era.hit_level_median_usd,
      min: era.hit_level_min_usd,
      max: era.hit_level_max_usd,
      percentile: era.hit_level_percentile,
    };
  }
  return {
    values: era.usage_at_hit_tokens,
    median: era.hit_level_median_tokens,
    min: era.hit_level_min_tokens,
    max: era.hit_level_max_tokens,
    percentile: era.hit_level_percentile_tokens,
  };
}

/** The window usage a single hit was measured at, on the selected basis. */
export function hitUsage(hit: LimitHitEntry, basis: LimitBasis): number | null {
  return basis === "cost" ? hit.usage_at_hit : hit.usage_at_hit_tokens;
}
