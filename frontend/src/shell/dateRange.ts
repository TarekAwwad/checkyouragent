// One meaning of a date range for every page: local calendar days, inclusive
// of today. Pages turn a resolved range into request bounds with
// instantBounds (local data) or dayBounds (team bundles, which store dates).

export type RangePreset = "today" | "7d" | "30d" | "90d" | "all" | "custom";

export interface DateRange {
  preset: RangePreset;
  /** Local YYYY-MM-DD, inclusive. Only read for "custom". */
  from: string | null;
  to: string | null;
}

/** Inclusive local days; null is an open end. */
export interface ResolvedRange {
  from: string | null;
  to: string | null;
}

export interface BoundPair {
  dateFrom: string | null;
  dateTo: string | null;
}

export const RANGE_PRESETS: RangePreset[] = ["today", "7d", "30d", "90d", "all", "custom"];

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
  custom: "Custom range",
};

const PRESET_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;

export const ALL_TIME: DateRange = { preset: "all", from: null, to: null };

export function presetRange(preset: Exclude<RangePreset, "custom">): DateRange {
  return { preset, from: null, to: null };
}

// YYYY-MM-DD of the local calendar day. toISOString() would give the UTC day,
// which is yesterday or tomorrow for part of every day outside UTC.
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayParts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** Local midnight starting `day` (shifted by whole calendar days). */
function localMidnight(day: string, offsetDays = 0): Date {
  const [y, m, d] = dayParts(day);
  return new Date(y, m - 1, d + offsetDays);
}

export function addDays(day: string, n: number): string {
  return localIsoDate(localMidnight(day, n));
}

function dayCount(from: string, to: string): number {
  const [y1, m1, d1] = dayParts(from);
  const [y2, m2, d2] = dayParts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

export function resolveRange(range: DateRange, today: string): ResolvedRange {
  if (range.preset === "all") return { from: null, to: null };
  if (range.preset === "custom") return { from: range.from, to: range.to };
  return { from: addDays(today, -(PRESET_DAYS[range.preset] - 1)), to: today };
}

/** Local-day window as UTC instants: start of `from` to the last millisecond of `to`. */
export function instantBounds(range: ResolvedRange): BoundPair {
  return {
    dateFrom: range.from ? localMidnight(range.from).toISOString() : null,
    dateTo: range.to ? new Date(localMidnight(range.to, 1).getTime() - 1).toISOString() : null,
  };
}

/** Local-day window as plain dates. */
export function dayBounds(range: ResolvedRange): BoundPair {
  return { dateFrom: range.from, dateTo: range.to };
}

/** The window of equal length that ends the day before `range` starts. */
export function previousRange(range: ResolvedRange): ResolvedRange | null {
  if (!range.from || !range.to) return null;
  const length = dayCount(range.from, range.to);
  if (length < 1) return null;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(length - 1)), to };
}

/** Local calendar day of an ISO instant, or the date itself for YYYY-MM-DD. */
export function toLocalDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : localIsoDate(parsed);
}

/** Last 30 days when there is activity inside them, otherwise everything. */
export function defaultPreset(latestDay: string | null, today: string): "30d" | "all" {
  const window = resolveRange(presetRange("30d"), today);
  return latestDay !== null && window.from !== null && latestDay >= window.from ? "30d" : "all";
}

/** True when an activity span [start, end] (ISO instants) overlaps the window. */
export function overlapsWindow(start: string | null, end: string | null, bounds: BoundPair): boolean {
  if (!bounds.dateFrom && !bounds.dateTo) return true;
  const first = Date.parse(start ?? end ?? "");
  const last = Date.parse(end ?? start ?? "");
  if (Number.isNaN(first) || Number.isNaN(last)) return false;
  if (bounds.dateTo && first > Date.parse(bounds.dateTo)) return false;
  if (bounds.dateFrom && last < Date.parse(bounds.dateFrom)) return false;
  return true;
}
