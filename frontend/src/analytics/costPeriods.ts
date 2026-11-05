import type { CostAnalyticsMeta, OverTimeBucket, SpendSpike } from "../api/types";

type Period = Pick<OverTimeBucket, "bucket" | "bucket_start" | "bucket_end">;
type BucketSize = CostAnalyticsMeta["bucket"];

const fullDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", timeZone: "UTC",
});

function utcDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function periodStart(period: Period, size: BucketSize): Date | null {
  const explicit = utcDate(period.bucket_start);
  if (explicit) return explicit;
  const datedKey = utcDate(period.bucket);
  if (datedKey) return datedKey;

  // Older API responses use calendar-year/%W keys. This is not an ISO week
  // number: week 01 begins on the first Monday, and week 00 precedes it.
  const legacyWeek = size === "week" && /^(\d{4})-(\d{2})$/.exec(period.bucket);
  if (!legacyWeek) return null;
  const week = Number(legacyWeek[2]);
  if (week > 53) return null;
  const first = new Date(`${legacyWeek[1]}-01-01T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() + (8 - first.getUTCDay()) % 7 + (week - 1) * 7);
  return first;
}

/** User-facing dates never expose the API's opaque weekly identifiers. */
export function formatCostPeriod(period: Period, size: BucketSize, compact = false): string {
  const start = periodStart(period, size);
  if (!start) return size === "week" ? "Unknown week" : "Unknown date";
  const date = (compact ? shortDate : fullDate).format(start);
  return size === "week" && !compact ? `Week of ${date}` : date;
}

export function spikeBaselineDescription(spike: SpendSpike, size: BucketSize): string {
  const count = spike.baseline_period_count;
  const periods = count !== undefined && count >= 3 && count <= 7 ? String(count) : "3–7";
  return `Median of preceding ${periods} complete ${size === "week" ? "weeks" : "days"}`;
}
